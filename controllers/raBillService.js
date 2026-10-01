'use strict';
// R.A. (Running Account) bills: each bill in a series claims part of the
// original (contract / BOQ) quantity of every item. For every item line:
//   Original Qty   — agreed quantity, carried over from the first bill
//   Previous Qty   — sum of the quantities billed in all earlier bills
//   This Bill Qty  — `quantity` (the only quantity that is billed / taxed now)
//   Cumulative Qty — Previous + This Bill
//   Balance Qty    — Original − Cumulative
// Previous / cumulative / balance are always recomputed from the stored
// earlier bills, so editing or deleting a bill keeps the whole series correct.
const { Op } = require('sequelize');
const { Invoice } = require('../models');
const { findScopedByPk } = require('./accountsCompanyScope');

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function round3(value) {
  return Math.round(num(value) * 1000) / 1000;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(parseFloat(value));
}

function newRaKey() {
  return 'ra-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// Stable identity of an item line across the bills of a series.
function raItemKey(item) {
  if (item && item.raKey) return String(item.raKey);
  const code = String((item && (item.itemCode || item.code)) || '').trim().toLowerCase();
  const name = String((item && (item.name || item.description || item.itemName)) || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return 'k:' + code + '|' + name;
}

function normalizedCustomer(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function seriesBills(seriesId, options) {
  if (!seriesId) return [];
  return Invoice.findAll(Object.assign({
    where: { isRABill: true, [Op.or]: [{ id: seriesId }, { raSeriesId: seriesId }] },
    order: [['raBillNo', 'ASC'], ['id', 'ASC']],
  }, options || {}));
}

// Fill raKey / originalQty / previousQty / cumulativeQty / balanceQty on items,
// given the bills of the series that come before this one.
function applyQuantities(items, earlierBills) {
  const previous = {};
  const original = {};
  earlierBills.forEach(bill => {
    (bill.items || []).forEach(it => {
      const key = raItemKey(it);
      previous[key] = (previous[key] || 0) + num(it.quantity);
      if (original[key] === undefined && hasValue(it.originalQty)) original[key] = num(it.originalQty);
    });
  });
  return (Array.isArray(items) ? items : []).map(it => {
    const key = raItemKey(it);
    const previousQty = round3(previous[key] || 0);
    // Once a line has appeared on an earlier R.A. bill, its agreed quantity
    // belongs to the series. A later bill must never be able to redefine it.
    const originalQty = original[key] !== undefined
      ? round3(original[key])
      : (hasValue(it.originalQty) ? round3(it.originalQty) : round3(previousQty + num(it.quantity)));
    const cumulativeQty = round3(previousQty + num(it.quantity));
    return Object.assign({}, it, {
      raKey: key,
      originalQty,
      previousQty,
      cumulativeQty,
      balanceQty: round3(originalQty - cumulativeQty),
    });
  });
}

// Called before create/update. Sets raBillNo / raSeriesId / raPrevBillId and
// the item quantities. `current` is the stored invoice when updating.
async function prepareRaBill(req, data, current) {
  if (!data.isRABill) {
    data.raBillNo = null;
    data.raSeriesId = null;
    data.raPrevBillId = null;
    return data;
  }

  const prevId = Number(data.raPrevBillId) || null;
  let seriesId = null;
  if (prevId) {
    if (current && prevId === current.id) throw httpError(400, 'An R.A. bill cannot be based on itself');
    const prev = await findScopedByPk(Invoice, 'invoice', req, prevId, null, 'Previous R.A. bill not found');
    if (!prev) throw httpError(404, 'Previous R.A. bill not found');
    if (!prev.isRABill) throw httpError(400, 'The previous bill must be an R.A. bill');
    const currentCustomer = normalizedCustomer(data.customerName || (current && current.customerName));
    const previousCustomer = normalizedCustomer(prev.customerName);
    if (currentCustomer && previousCustomer && currentCustomer !== previousCustomer) {
      throw httpError(400, 'The previous R.A. bill must belong to the same customer');
    }
    if (data.clientId && prev.clientId && Number(data.clientId) !== Number(prev.clientId)) {
      throw httpError(400, 'The previous R.A. bill must belong to the same client');
    }
    seriesId = prev.raSeriesId || prev.id;
    const bills = await seriesBills(seriesId);
    const isExistingLink = !!(current && Number(current.raPrevBillId) === prevId && (current.raSeriesId || current.id) === seriesId);
    if (current && !isExistingLink && current.isRABill) {
      throw httpError(400, 'The previous R.A. bill cannot be changed after creation. Create a new next R.A. bill instead.');
    }
    if (!isExistingLink) {
      const latest = bills.filter(b => !current || b.id !== current.id).sort((a, b) => {
        const byNumber = (Number(b.raBillNo) || 0) - (Number(a.raBillNo) || 0);
        return byNumber || (Number(b.id) - Number(a.id));
      })[0];
      if (latest && latest.id !== prev.id) {
        throw httpError(400, 'Choose the latest R.A. bill in this series as the previous bill');
      }
      // The series number is derived from the selected predecessor, not a
      // browser value, so duplicate or skipped R.A. bill numbers cannot occur.
      data.raBillNo = (Number(prev.raBillNo) || 1) + 1;
    }
  } else {
    if (current && current.isRABill && current.raPrevBillId) {
      throw httpError(400, 'The previous R.A. bill cannot be removed after creation');
    }
    data.raPrevBillId = null;
    seriesId = current ? (current.raPrevBillId ? null : current.id) : null;
    data.raBillNo = 1;
  }
  data.raBillNo = Math.max(1, parseInt(data.raBillNo, 10) || 1);
  data.raSeriesId = seriesId; // the first bill gets its own id after create

  const bills = await seriesBills(seriesId);
  const earlier = bills.filter(b => (!current || b.id !== current.id) && (Number(b.raBillNo) || 0) < data.raBillNo);
  data.items = applyQuantities(data.items, earlier);
  return data;
}

// After a bill is created / edited / deleted: recompute previous / cumulative /
// balance quantities of every bill in the series so later bills stay connected.
async function refreshSeries(seriesId) {
  const bills = await seriesBills(seriesId);
  const done = [];
  for (const bill of bills) {
    const items = applyQuantities(bill.items, done);
    if (JSON.stringify(items) !== JSON.stringify(bill.items)) {
      bill.items = items;
      await bill.save({ hooks: false });
    }
    done.push(bill);
  }
}

// Draft for "Create next R.A. bill" (or the first R.A. bill from an ordinary
// invoice / work-order bill whose quantities become the original quantities).
async function buildNextRaDraft(base) {
  const copyFields = [
    'documentType', 'invoiceType', 'placeOfSupply', 'taxExempt', 'showTaxInPdf', 'showTaxPercentInPdf',
    'sgstRate', 'cgstRate', 'workOrder', 'projectName', 'workDetails',
    'sellerName', 'sellerGstin', 'sellerAddress', 'sellerState', 'sellerStateCode', 'sellerPhone', 'sellerEmail', 'sellerPan',
    'customerName', 'customerGstin', 'customerPan', 'customerEmail', 'customerAddress', 'customerState', 'customerStateCode',
    'bankName', 'bankAcName', 'bankAccount', 'bankIfsc', 'bankBranch', 'termsConditions',
    'companyId', 'clientId', 'vendorId', 'projectAccountId', 'pdfOrientation', 'roundOffMode',
  ];
  const draft = {};
  copyFields.forEach(f => { draft[f] = base[f]; });
  draft.isRABill = true;

  const lineFrom = (it, raKey, originalQty, previousQty) => ({
    raKey,
    itemCode: it.itemCode || '',
    name: it.name || it.description || '',
    hsnCode: it.hsnCode || '',
    unit: it.unit || '',
    unitPrice: num(it.unitPrice),
    taxRate: num(it.taxRate),
    originalQty: round3(originalQty),
    previousQty: round3(previousQty),
    quantity: 0,
    cumulativeQty: round3(previousQty),
    balanceQty: round3(originalQty - previousQty),
  });

  let prev = base;
  if (base.isRABill) {
    // Next bill after the latest one of the series; every line ever billed in
    // the series is carried over with its quantity billed so far.
    const bills = await seriesBills(base.raSeriesId || base.id);
    prev = bills[bills.length - 1] || base;
    draft.raSeriesId = base.raSeriesId || base.id;
    draft.raPrevBillId = prev.id;
    draft.raBillNo = Math.max.apply(null, bills.map(b => Number(b.raBillNo) || 1).concat([0])) + 1;
    const lines = new Map();
    bills.forEach(bill => (bill.items || []).forEach(it => {
      const key = raItemKey(it);
      if (!lines.has(key)) lines.set(key, { it, originalQty: null, billed: 0 });
      const line = lines.get(key);
      line.it = it; // latest description / rate
      line.billed += num(it.quantity);
      if (line.originalQty === null && hasValue(it.originalQty)) line.originalQty = num(it.originalQty);
    }));
    draft.items = Array.from(lines.entries()).map(([key, line]) =>
      lineFrom(line.it, key, line.originalQty === null ? line.billed : line.originalQty, line.billed));
  } else {
    // First R.A. bill from an ordinary bill: its quantities are the original quantities.
    draft.raSeriesId = null;
    draft.raPrevBillId = null;
    draft.raBillNo = 1;
    draft.items = (base.items || []).map(it => lineFrom(it, newRaKey(), num(it.quantity), 0));
  }
  draft.raBasedOn = {
    id: prev.id,
    invoiceNumber: prev.invoiceNumber,
    raBillNo: prev.raBillNo || null,
    isRABill: !!base.isRABill,
  };
  return draft;
}

module.exports = {
  prepareRaBill,
  refreshSeries,
  buildNextRaDraft,
  raItemKey,
  applyQuantities,
};
