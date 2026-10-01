'use strict';
// Payments received against invoices / R.A. bills (or as advances). Every
// payment stores its own breakup and has its own Payment Breakup PDF:
//   Net = Gross + GST − TDS − GST TDS − Retention − Advance Recovery − Other Recovery
// TDS uses the TDS master (rate + single / FY-aggregate thresholds).
const { Op } = require('sequelize');
const { Payment, Invoice, Client, Company, TdsRule } = require('../models');
const {
  assertScopedRelation,
  findScopedByPk,
  getActorCompanyId,
  isAdminScoped,
  syncAccountsCompanyIds,
} = require('./accountsCompanyScope');
const { ensureCompanyTdsRules, calculateTds, ruleAppliesOn } = require('./tdsController');
const {
  W, X, BLK, GRY, HBG, LBD,
  fmtDate, fmtINR, numWords, buildPdfFilename, createDoc, addFooters, drawHeader, drawSectionLabel,
} = require('./pdfHelper');

const MONEY_FIELDS = ['grossAmount', 'gstAmount', 'tdsBaseAmount', 'tdsAmount', 'gstTdsAmount', 'retentionAmount',
  'advanceRecovery', 'otherRecovery', 'totalDeductions', 'netAmount'];
const PERCENT_FIELDS = ['gstRate', 'tdsRate', 'gstTdsRate', 'retentionRate'];

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}
function hasValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(parseFloat(value));
}
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function cleanDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Indian financial year of a YYYY-MM-DD date, e.g. 2026-07-31 → "26-27"
function financialYearOf(date) {
  const [y, m] = String(date).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return String(start).slice(-2) + '-' + String(start + 1).slice(-2);
}

// DECIMAL columns come back as strings — expose numbers.
function serialize(payment) {
  const plain = payment && typeof payment.toJSON === 'function' ? payment.toJSON() : Object.assign({}, payment);
  MONEY_FIELDS.concat(PERCENT_FIELDS).forEach(f => { plain[f] = num(plain[f]); });
  if (plain.invoice) {
    ['subtotal', 'totalTax', 'totalAmount'].forEach(f => { plain.invoice[f] = num(plain.invoice[f]); });
  }
  return plain;
}

// GST rate of an invoice as billed (total tax ÷ taxable value).
function effectiveGstRate(invoice) {
  if (!invoice || invoice.taxExempt) return 0;
  const subtotal = num(invoice.subtotal);
  if (subtotal <= 0) return 0;
  return Math.round(num(invoice.totalTax) / subtotal * 100 * 1000) / 1000;
}

async function invoicePayments(invoiceId, excludeId) {
  const where = { invoiceId, paymentType: 'bill' };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return Payment.findAll({ where, order: [['paymentDate', 'ASC'], ['id', 'ASC']] });
}

function settlementOf(invoice, payments) {
  const grossPaid = round2(payments.reduce((s, p) => s + num(p.grossAmount), 0));
  const settled = round2(payments.reduce((s, p) => s + num(p.grossAmount) + num(p.gstAmount), 0));
  const netReceived = round2(payments.reduce((s, p) => s + num(p.netAmount), 0));
  const tds = round2(payments.reduce((s, p) => s + num(p.tdsAmount), 0));
  const retention = round2(payments.reduce((s, p) => s + num(p.retentionAmount), 0));
  return {
    invoiceTotal: round2(invoice.totalAmount),
    subtotal: round2(invoice.subtotal),
    grossPaid,
    settled,
    netReceived,
    tds,
    retention,
    count: payments.length,
    remainingGross: round2(Math.max(0, num(invoice.subtotal) - grossPaid)),
    balance: round2(num(invoice.totalAmount) - settled),
  };
}

// Advance received from a client minus advance already recovered from bills.
async function advanceOutstanding(companyId, clientId, excludeId) {
  if (!clientId) return 0;
  const where = { clientId };
  if (companyId) where.companyId = companyId;
  if (excludeId) where.id = { [Op.ne]: excludeId };
  const rows = await Payment.findAll({ where, attributes: ['paymentType', 'grossAmount', 'advanceRecovery'] });
  const received = rows.filter(r => r.paymentType === 'advance').reduce((s, r) => s + num(r.grossAmount), 0);
  const recovered = rows.reduce((s, r) => s + num(r.advanceRecovery), 0);
  return round2(received - recovered);
}

// Update the invoice's payment status from its payments.
async function refreshInvoicePaymentStatus(invoiceId) {
  if (!invoiceId) return;
  const invoice = await Invoice.findByPk(invoiceId);
  if (!invoice) return;
  const payments = await invoicePayments(invoiceId);
  const s = settlementOf(invoice, payments);
  const updates = {};
  if (!payments.length) {
    if (invoice.paymentStatus === 'Partial' || invoice.paymentStatus === 'Paid') updates.paymentStatus = 'Unpaid';
    if (invoice.status === 'Paid') updates.status = 'Sent';
    updates.paidAt = null;
  } else if (s.balance <= 0.5) {
    const last = payments[payments.length - 1];
    updates.paymentStatus = 'Paid';
    updates.status = 'Paid';
    updates.paidAt = new Date(last.paymentDate + 'T00:00:00');
    updates.paymentMode = last.paymentMode || invoice.paymentMode;
  } else {
    updates.paymentStatus = 'Partial';
    if (invoice.status === 'Paid') updates.status = 'Sent';
  }
  await invoice.update(updates, { hooks: false });
}

async function nextPaymentNumber(companyId, financialYear) {
  const rows = await Payment.findAll({
    where: { companyId: companyId || null, financialYear },
    attributes: ['paymentNumber'],
    raw: true,
  });
  let max = 0;
  rows.forEach(r => {
    const m = String(r.paymentNumber || '').match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `PAY/${financialYear}/${String(max + 1).padStart(4, '0')}`;
}

// Suggest a TDS rule: the client's last one, else contractor rate by the payee (seller) PAN.
function suggestRule(rules, lastRuleId, sellerPan) {
  if (lastRuleId && rules.some(r => r.id === lastRuleId)) return lastRuleId;
  const holder = String(sellerPan || '').trim().toUpperCase().charAt(3);
  const code = holder === 'P' || holder === 'H' ? 'TDS-CON-IND' : 'TDS-CON-OTH';
  const rule = rules.find(r => r.code === code);
  return rule ? rule.id : null;
}

// Resolve invoice / client / company and calculate the whole breakup.
async function buildBreakup(req, body, existing) {
  const paymentType = body.paymentType === 'advance' ? 'advance' : 'bill';
  let invoice = null;
  let client = null;
  if (paymentType === 'bill') {
    if (!body.invoiceId) throw httpError(400, 'Select the invoice / R.A. bill this payment is for');
    invoice = await findScopedByPk(Invoice, 'invoice', req, body.invoiceId, null, 'Invoice not found');
    if (!invoice) throw httpError(404, 'Invoice not found');
    if (invoice.clientId) client = await Client.findByPk(invoice.clientId);
  } else {
    if (!body.clientId) throw httpError(400, 'Select the client the advance is received from');
    client = await assertScopedRelation(Client, 'client', req, body.clientId, 'Client not found');
  }

  const companyId = (invoice && invoice.companyId) || (client && client.companyId) || getActorCompanyId(req) || null;
  if (isAdminScoped(req) && Number(companyId) !== getActorCompanyId(req)) throw httpError(404, 'Invoice not found');

  const paymentDate = cleanDate(body.paymentDate) || todayIso();
  const financialYear = financialYearOf(paymentDate);
  const grossAmount = round2(body.grossAmount);
  if (grossAmount <= 0) throw httpError(400, 'Gross amount must be more than 0');

  const gstRate = hasValue(body.gstRate) ? Math.max(0, num(body.gstRate)) : effectiveGstRate(invoice);
  const gstAmount = round2(grossAmount * gstRate / 100);

  const party = {
    clientId: client ? client.id : (invoice ? invoice.clientId : null),
    partyName: (invoice && invoice.customerName) || (client && client.name) || '',
    partyGstin: (invoice && invoice.customerGstin) || (client && client.gstin) || '',
    partyPan: (invoice && invoice.customerPan) || (client && client.pan) || '',
  };

  // ── TDS from the master: rate + thresholds for this party in this FY ──
  let rule = null;
  if (body.tdsRuleId) {
    rule = await TdsRule.findByPk(body.tdsRuleId);
    if (!rule || (companyId && rule.companyId && Number(rule.companyId) !== Number(companyId))) {
      throw httpError(400, 'Selected TDS rule not found for this company');
    }
    if (!ruleAppliesOn(rule, paymentDate)) {
      throw httpError(400, `TDS rule ${rule.code} is not active on ${fmtDate(paymentDate)}`);
    }
  }
  let tds = { applicable: false, rate: 0, taxableAmount: 0, tdsAmount: 0, note: 'No TDS rule selected', aggregateBefore: 0, aggregateAfter: grossAmount };
  if (rule) {
    const partyWhere = { companyId, financialYear, tdsCode: rule.code };
    if (party.clientId) partyWhere.clientId = party.clientId;
    else partyWhere.partyName = party.partyName;
    if (existing) partyWhere.id = { [Op.ne]: existing.id };
    const prior = await Payment.findAll({ where: partyWhere, attributes: ['grossAmount', 'tdsBaseAmount'] });
    const aggregate = prior.reduce((s, p) => s + num(p.grossAmount), 0);
    const taxedBase = prior.reduce((s, p) => s + num(p.tdsBaseAmount), 0);
    tds = calculateTds(rule, grossAmount, { aggregate, untaxed: aggregate - taxedBase });
  }
  const tdsOverride = body.tdsOverride === true || body.tdsOverride === 'true';
  let tdsAmount = tds.tdsAmount;
  let tdsNote = tds.note;
  if (tdsOverride) {
    tdsAmount = Math.max(0, round2(body.tdsAmount));
    tdsNote = 'TDS entered manually (' + fmtINR(tdsAmount) + '); calculated as per master: ' + fmtINR(tds.tdsAmount) + ' — ' + tds.note;
  }

  const gstTdsRate = Math.max(0, num(body.gstTdsRate));
  const gstTdsAmount = Math.round(grossAmount * gstTdsRate / 100);
  const retentionRate = Math.max(0, num(body.retentionRate));
  const retentionAmount = round2(grossAmount * retentionRate / 100);
  const advanceRecovery = Math.max(0, round2(body.advanceRecovery));
  const otherRecovery = Math.max(0, round2(body.otherRecovery));
  const totalDeductions = round2(tdsAmount + gstTdsAmount + retentionAmount + advanceRecovery + otherRecovery);
  const netAmount = round2(grossAmount + gstAmount - totalDeductions);
  if (netAmount < 0) throw httpError(400, 'Total deductions are more than the bill amount');

  const fields = {
    paymentType,
    companyId,
    invoiceId: invoice ? invoice.id : null,
    clientId: party.clientId,
    partyName: party.partyName,
    partyGstin: party.partyGstin,
    partyPan: party.partyPan,
    invoiceNumber: invoice ? invoice.invoiceNumber : '',
    raBillNo: invoice && invoice.isRABill ? invoice.raBillNo : null,
    paymentDate,
    financialYear,
    paymentMode: String(body.paymentMode || '').slice(0, 40),
    referenceNo: String(body.referenceNo || '').slice(0, 120),
    bankName: String(body.bankName || '').slice(0, 120),
    notes: body.notes || '',
    grossAmount,
    gstRate,
    gstAmount,
    tdsRuleId: rule ? rule.id : null,
    tdsCode: rule ? rule.code : '',
    tdsSection: rule ? rule.section : '',
    tdsNature: rule ? rule.nature : '',
    tdsRate: rule ? num(rule.rate) : 0,
    tdsBaseAmount: tdsOverride ? (tdsAmount > 0 ? Math.max(tds.taxableAmount, grossAmount) : 0) : tds.taxableAmount,
    tdsAmount,
    tdsOverride,
    tdsNote,
    gstTdsRate,
    gstTdsAmount,
    retentionRate,
    retentionAmount,
    advanceRecovery,
    otherRecovery,
    otherRecoveryNote: String(body.otherRecoveryNote || '').slice(0, 200),
    totalDeductions,
    netAmount,
  };

  const context = { tds, advanceOutstanding: await advanceOutstanding(companyId, party.clientId, existing && existing.id) };
  if (invoice) {
    const before = settlementOf(invoice, await invoicePayments(invoice.id, existing && existing.id));
    context.invoice = {
      id: invoice.id, invoiceNumber: invoice.invoiceNumber, raBillNo: invoice.raBillNo, isRABill: !!invoice.isRABill,
      invoiceDate: invoice.invoiceDate, totalAmount: round2(invoice.totalAmount), subtotal: round2(invoice.subtotal),
    };
    context.settlement = Object.assign(before, {
      thisPayment: round2(grossAmount + gstAmount),
      balanceAfter: round2(before.balance - grossAmount - gstAmount),
    });
  }
  return { fields, context };
}

async function findScopedPayment(req, id, options) {
  const payment = await Payment.findByPk(id, options);
  if (!payment) return null;
  if (isAdminScoped(req) && Number(payment.companyId) !== getActorCompanyId(req)) return null;
  return payment;
}

// ── GET /payments ────────────────────────────────────────────────────────────
exports.getPayments = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = {};
    if (isAdminScoped(req)) where.companyId = getActorCompanyId(req) || -1;
    else if (req.query.companyId) where.companyId = req.query.companyId;
    if (req.query.invoiceId) where.invoiceId = req.query.invoiceId;
    if (req.query.clientId) where.clientId = req.query.clientId;
    if (req.query.financialYear) where.financialYear = req.query.financialYear;
    if (req.query.type) where.paymentType = req.query.type;
    if (req.query.q) {
      const q = `%${req.query.q}%`;
      where[Op.or] = [
        { paymentNumber: { [Op.like]: q } }, { partyName: { [Op.like]: q } },
        { invoiceNumber: { [Op.like]: q } }, { referenceNo: { [Op.like]: q } },
      ];
    }
    const rows = await Payment.findAll({
      where,
      include: [{ model: Invoice, as: 'invoice', attributes: ['id', 'invoiceNumber', 'raBillNo', 'isRABill', 'invoiceDate', 'totalAmount', 'subtotal', 'totalTax'] }],
      order: [['paymentDate', 'DESC'], ['id', 'DESC']],
    });
    res.json(rows.map(serialize));
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /payments/context — defaults for the payment form ────────────────────
exports.getPaymentContext = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const excludeId = Number(req.query.paymentId) || null;
    let invoice = null;
    let client = null;
    if (req.query.invoiceId) {
      invoice = await findScopedByPk(Invoice, 'invoice', req, req.query.invoiceId, null, 'Invoice not found');
      if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
      if (invoice.clientId) client = await Client.findByPk(invoice.clientId);
    } else if (req.query.clientId) {
      client = await assertScopedRelation(Client, 'client', req, req.query.clientId, 'Client not found');
    }
    const companyId = (invoice && invoice.companyId) || (client && client.companyId) || getActorCompanyId(req) || Number(req.query.companyId) || null;
    if (companyId) await ensureCompanyTdsRules(companyId);
    const rules = companyId
      ? await TdsRule.findAll({ where: { companyId, active: true }, order: [['code', 'ASC']] })
      : [];
    const clientId = client ? client.id : (invoice ? invoice.clientId : null);
    const lastWhere = { companyId };
    if (clientId) lastWhere.clientId = clientId;
    else if (invoice) lastWhere.partyName = invoice.customerName;
    const last = (clientId || invoice)
      ? await Payment.findOne({ where: Object.assign(lastWhere, excludeId ? { id: { [Op.ne]: excludeId } } : {}), order: [['paymentDate', 'DESC'], ['id', 'DESC']] })
      : null;

    const out = {
      companyId,
      rules,
      suggestedTdsRuleId: suggestRule(rules, last && last.tdsRuleId, invoice ? invoice.sellerPan : ''),
      lastPayment: last ? { tdsRuleId: last.tdsRuleId, gstTdsRate: num(last.gstTdsRate), retentionRate: num(last.retentionRate) } : null,
      advanceOutstanding: await advanceOutstanding(companyId, clientId, excludeId),
      client: client ? { id: client.id, name: client.name, gstin: client.gstin, pan: client.pan } : null,
    };
    if (invoice) {
      const s = settlementOf(invoice, await invoicePayments(invoice.id, excludeId));
      out.invoice = {
        id: invoice.id, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate,
        isRABill: !!invoice.isRABill, raBillNo: invoice.raBillNo, customerName: invoice.customerName,
        subtotal: round2(invoice.subtotal), totalTax: round2(invoice.totalTax), totalAmount: round2(invoice.totalAmount),
        gstRate: effectiveGstRate(invoice), sellerPan: invoice.sellerPan,
      };
      out.settlement = s;
    }
    res.json(out);
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── POST /payments/preview — calculate the breakup without saving ────────────
exports.previewPayment = async (req, res) => {
  try {
    const existing = req.body.paymentId ? await findScopedPayment(req, req.body.paymentId) : null;
    const { fields, context } = await buildBreakup(req, req.body, existing);
    res.json(Object.assign(serialize(fields), { context }));
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── GET /payments/:id ────────────────────────────────────────────────────────
exports.getPayment = async (req, res) => {
  try {
    const payment = await findScopedPayment(req, req.params.id, {
      include: [{ model: Invoice, as: 'invoice', attributes: ['id', 'invoiceNumber', 'raBillNo', 'isRABill', 'invoiceDate', 'totalAmount', 'subtotal', 'totalTax'] }],
    });
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    res.json(serialize(payment));
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /payments ───────────────────────────────────────────────────────────
exports.createPayment = async (req, res) => {
  try {
    const { fields, context } = await buildBreakup(req, req.body, null);
    fields.paymentNumber = await nextPaymentNumber(fields.companyId, fields.financialYear);
    fields.createdBy = req.user.id;
    const payment = await Payment.create(fields);
    await refreshInvoicePaymentStatus(payment.invoiceId);
    res.status(201).json(Object.assign(serialize(payment), { context }));
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── PUT /payments/:id ────────────────────────────────────────────────────────
exports.updatePayment = async (req, res) => {
  try {
    const payment = await findScopedPayment(req, req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    const body = Object.assign({}, serialize(payment), req.body);
    const oldInvoiceId = payment.invoiceId;
    const { fields, context } = await buildBreakup(req, body, payment);
    if (fields.financialYear !== payment.financialYear || Number(fields.companyId) !== Number(payment.companyId)) {
      fields.paymentNumber = await nextPaymentNumber(fields.companyId, fields.financialYear);
    }
    await payment.update(fields);
    await refreshInvoicePaymentStatus(payment.invoiceId);
    if (oldInvoiceId && oldInvoiceId !== payment.invoiceId) await refreshInvoicePaymentStatus(oldInvoiceId);
    res.json(Object.assign(serialize(payment), { context }));
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── DELETE /payments/:id ─────────────────────────────────────────────────────
exports.deletePayment = async (req, res) => {
  try {
    const payment = await findScopedPayment(req, req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('payment', payment.id, req.user, payment.toJSON(), payment.paymentNumber);
    const invoiceId = payment.invoiceId;
    await payment.destroy();
    await refreshInvoicePaymentStatus(invoiceId);
    res.json({ message: 'Payment deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /payments/:id/pdf — Payment Breakup ──────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    const record = await findScopedPayment(req, req.params.id);
    if (!record) return res.status(404).json({ message: 'Payment not found' });
    const p = serialize(record);
    const invoice = p.invoiceId ? await Invoice.findByPk(p.invoiceId) : null;
    const company = p.companyId ? await Company.findByPk(p.companyId) : null;
    const client = p.clientId ? await Client.findByPk(p.clientId) : null;
    const settlement = invoice ? settlementOf(invoice, await invoicePayments(invoice.id, p.id)) : null;

    const seller = {
      name: (invoice && invoice.sellerName) || (company && company.name) || '',
      address: (invoice && invoice.sellerAddress) || (company && company.address) || '',
      phone: (invoice && invoice.sellerPhone) || (company && company.phone) || '',
      email: (invoice && invoice.sellerEmail) || (company && company.email) || '',
      gstin: (invoice && invoice.sellerGstin) || (company && company.gstNo) || '',
      pan: (invoice && invoice.sellerPan) || (company && company.panNo) || '',
    };

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') +
      `; filename="${buildPdfFilename([seller.name || 'Company', 'Payment-Breakup', p.paymentNumber])}"`);

    const h = createDoc();
    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = h;
    doc.pipe(res);
    const HW = W / 2;

    // 1. Header
    const sellerLines = [
      seller.name,
      seller.address ? 'Address: ' + seller.address : '',
      [seller.phone ? 'Phone: ' + seller.phone : '', seller.email ? 'Email: ' + seller.email : ''].filter(Boolean).join(' | '),
      [seller.gstin ? 'GSTIN: ' + seller.gstin : '', seller.pan ? 'PAN: ' + seller.pan : ''].filter(Boolean).join(' | '),
    ].filter(Boolean);
    const metaRight = [
      'PAYMENT BREAKUP',
      'Payment No.: ' + p.paymentNumber,
      'Payment Date: ' + fmtDate(p.paymentDate),
      'Financial Year: 20' + p.financialYear,
      [p.paymentMode ? 'Mode: ' + p.paymentMode : '', p.referenceNo ? 'Ref: ' + p.referenceNo : ''].filter(Boolean).join(' | '),
    ].filter(Boolean);
    let y = drawHeader(h, metaRight, sellerLines);

    // 2. Received from
    y = drawSectionLabel(h, p.paymentType === 'advance' ? 'Advance Received From:' : 'Received From:', y);
    const partyLeft = [p.partyName || '-', (invoice && invoice.customerAddress) || (client && client.billingAddress) || ''].filter(Boolean);
    const partyRight = [
      p.partyGstin ? 'GSTIN: ' + p.partyGstin : '',
      p.partyPan ? 'PAN: ' + p.partyPan : '',
      p.bankName ? 'Bank: ' + p.bankName : '',
    ].filter(Boolean);
    const partyH = Math.max(
      partyLeft.reduce((s, l, i) => s + txtH(l, HW - 12, i === 0 ? 8.5 : 7.5, i === 0) + 1.5, 6),
      partyRight.reduce((s, l) => s + txtH(l, HW - 12, 7.5) + 1.5, 6)
    ) + 3;
    box(X, y, W, partyH, LBD);
    vLine(X + HW, y, y + partyH, LBD);
    let py = y + 4;
    partyLeft.forEach((line, i) => { txt(line, X + 5, py, HW - 10, { size: i === 0 ? 8.5 : 7.5, bold: i === 0, color: BLK }); py = doc.y + 0.5; });
    py = y + 4;
    partyRight.forEach(line => { txt(line, X + HW + 4, py, HW - 10, { size: 7.5, color: BLK }); py = doc.y + 0.5; });
    y += partyH;

    // 3. Related invoice / R.A. bill
    if (invoice) {
      y = drawSectionLabel(h, 'Against Invoice / R.A. Bill:', y);
      const facts = [
        ['Invoice No.', invoice.invoiceNumber || '-'],
        ['Invoice Date', fmtDate(invoice.invoiceDate)],
        ['R.A. Bill No.', invoice.isRABill ? String(invoice.raBillNo || 1) : 'Not an R.A. bill'],
        ['Invoice Total (incl. GST)', fmtINR(invoice.totalAmount)],
        ['Work Order', invoice.workOrder || '-'],
        ['Project', invoice.projectName || '-'],
      ];
      const rowH = 13;
      const rows = Math.ceil(facts.length / 2);
      box(X, y, W, rows * rowH, LBD);
      vLine(X + HW, y, y + rows * rowH, LBD);
      facts.forEach(([label, value], i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const fx = X + col * HW;
        const fy = y + row * rowH;
        if (row > 0 && col === 0) hLine(fy, X, X + W, LBD);
        txt(label + ':', fx + 5, fy + 3, 110, { size: 7.5, color: GRY });
        txt(value, fx + 115, fy + 3, HW - 120, { size: 7.5, bold: true, color: BLK, lineBreak: false, ellipsis: true });
      });
      y += rows * rowH;
    }

    // 4. Breakup table
    y = drawSectionLabel(h, 'Payment Breakup', y);
    const C1 = 210, C2 = W - 210 - 120, C3 = 120;
    const pct = v => (Number.isInteger(num(v)) ? String(num(v)) : String(parseFloat(num(v).toFixed(3)))) + '%';
    const tdsLabel = p.tdsCode
      ? 'Less: TDS' + (p.tdsSection ? ' u/s ' + p.tdsSection : '') + ' @ ' + pct(p.tdsRate) + ' (' + p.tdsCode + ')'
      : 'Less: TDS';
    const tdsBasis = p.tdsCode
      ? (p.tdsAmount > 0 ? 'On ' + fmtINR(p.tdsBaseAmount) + ' — ' : '') + (p.tdsNote || '')
      : 'No TDS rule applied';
    const lines = [
      ['Gross Bill / Payment Amount (excl. GST)', 'Input', p.grossAmount, false],
      ['Add: GST @ ' + pct(p.gstRate), 'Gross × GST %', p.gstAmount, false],
      ['Total Bill Amount (incl. GST)', 'Gross + GST', p.grossAmount + p.gstAmount, true],
      [tdsLabel, tdsBasis, -p.tdsAmount, false],
      ['Less: GST TDS @ ' + pct(p.gstTdsRate), p.gstTdsRate > 0 ? 'Gross × GST TDS %' : 'Not applicable', -p.gstTdsAmount, false],
      ['Less: Retention / Security Deposit @ ' + pct(p.retentionRate), p.retentionRate > 0 ? 'Gross × Retention %' : 'Not applicable', -p.retentionAmount, false],
      ['Less: Advance Recovery', p.advanceRecovery > 0 ? 'Recovered from advance received' : 'Not applicable', -p.advanceRecovery, false],
      ['Less: Other Recovery', p.otherRecoveryNote || (p.otherRecovery > 0 ? 'Input' : 'Not applicable'), -p.otherRecovery, false],
      ['Total Deductions', 'TDS + GST TDS + Retention + Advance + Other', -p.totalDeductions, true],
    ];
    const headH = 13;
    fillBox(X, y, W, headH, HBG);
    box(X, y, W, headH, LBD);
    vLine(X + C1, y, y + headH, LBD);
    vLine(X + C1 + C2, y, y + headH, LBD);
    txt('Particular', X + 5, y + 3, C1 - 10, { size: 7.5, bold: true, color: BLK });
    txt('Basis / Formula', X + C1 + 5, y + 3, C2 - 10, { size: 7.5, bold: true, color: BLK });
    txt('Amount', X + C1 + C2 + 5, y + 3, C3 - 10, { size: 7.5, bold: true, color: BLK, align: 'right' });
    y += headH;
    lines.forEach(([label, basis, amount, bold]) => {
      const rowH = Math.max(14, txtH(basis, C2 - 10, 7) + 7, txtH(label, C1 - 10, 7.5, bold) + 7);
      y = checkPage(y, rowH);
      if (bold) fillBox(X, y, W, rowH, '#fafafa');
      box(X, y, W, rowH, LBD);
      vLine(X + C1, y, y + rowH, LBD);
      vLine(X + C1 + C2, y, y + rowH, LBD);
      txt(label, X + 5, y + 4, C1 - 10, { size: 7.5, bold, color: BLK });
      txt(basis, X + C1 + 5, y + 4, C2 - 10, { size: 7, color: GRY });
      const shown = amount < 0 ? '(-) ' + fmtINR(-amount) : fmtINR(amount);
      txt(shown, X + C1 + C2 + 5, y + 4, C3 - 10, { size: 7.5, bold, color: BLK, align: 'right' });
      y += rowH;
    });
    const netH = 18;
    y = checkPage(y, netH);
    fillBox(X, y, W, netH, HBG);
    box(X, y, W, netH, LBD);
    txt(p.paymentType === 'advance' ? 'NET ADVANCE RECEIVED' : 'NET AMOUNT RECEIVED / PAYABLE', X + 5, y + 5, C1 + C2 - 10, { size: 8.5, bold: true, color: BLK });
    txt(fmtINR(p.netAmount), X + C1 + C2 + 5, y + 5, C3 - 10, { size: 8.5, bold: true, color: BLK, align: 'right' });
    y += netH;
    const words = numWords(p.netAmount);
    const wordsH = txtH(words, W - 10, 7.5) + 14;
    y = checkPage(y, wordsH);
    box(X, y, W, wordsH, LBD);
    txt('Amount in Words:', X + 5, y + 3, W - 10, { size: 7.5, bold: true, color: BLK });
    txt(words, X + 5, y + 12, W - 10, { size: 7.5, color: BLK });
    y += wordsH;

    // 5. Invoice settlement after this payment
    if (invoice && settlement) {
      y = checkPage(y, 11 + 28);
      y = drawSectionLabel(h, 'Invoice Settlement', y);
      const thisPayment = round2(p.grossAmount + p.gstAmount);
      const cols = [
        ['Invoice Total', settlement.invoiceTotal],
        ['Settled Earlier', settlement.settled],
        ['This Payment (Gross + GST)', thisPayment],
        ['Balance After This Payment', round2(settlement.balance - thisPayment)],
      ];
      const cw = W / cols.length;
      const sH = 28;
      box(X, y, W, sH, LBD);
      cols.forEach(([label, value], i) => {
        const cx = X + i * cw;
        if (i) vLine(cx, y, y + sH, LBD);
        txt(label, cx + 4, y + 4, cw - 8, { size: 6.8, color: GRY, align: 'center' });
        txt(fmtINR(value), cx + 4, y + 15, cw - 8, { size: 8, bold: true, color: BLK, align: 'center' });
      });
      y += sH;
    }

    // 6. Notes + signature
    const note = String(p.notes || '').trim();
    if (note) {
      const noteH = txtH('Remarks: ' + note, W - 10, 7) + 8;
      y = checkPage(y, noteH);
      box(X, y, W, noteH, LBD);
      txt('Remarks: ' + note, X + 5, y + 4, W - 10, { size: 7, color: GRY });
      y += noteH;
    }
    const signH = 44;
    y = checkPage(y, signH);
    box(X, y, W, signH, LBD);
    vLine(X + HW, y, y + signH, LBD);
    txt('Received / verified by', X + 5, y + 4, HW - 10, { size: 7.5, bold: true, color: BLK });
    txt('For ' + (seller.name || ''), X + HW + 5, y + signH - 21, HW - 10, { size: 7.5, bold: true, color: BLK, align: 'right' });
    txt('Authorized Signatory', X + HW + 5, y + signH - 11, HW - 10, { size: 7.5, color: BLK, align: 'right' });

    addFooters(doc, { infoText: 'This is a computer-generated payment breakup.' });
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};

exports.refreshInvoicePaymentStatus = refreshInvoicePaymentStatus;
exports.settlementOf = settlementOf;
