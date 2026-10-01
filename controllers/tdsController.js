'use strict';
const { Op } = require('sequelize');
const { TdsRule, Company } = require('../models');
const { getActorCompanyId, isAdminScoped } = require('./accountsCompanyScope');

// Default TDS master (FY 2026-27). Every company gets its own editable copy.
const DEFAULT_TDS_RULES = [
  { code: 'TDS-CON-IND', nature: 'Contractor / Sub-contractor', section: '194C', payeeType: 'Individual / HUF', rate: 1,
    singleLimit: 30000, aggregateLimit: 100000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while a single payment is up to ₹30,000 and the FY aggregate is up to ₹1,00,000.' },
  { code: 'TDS-CON-OTH', nature: 'Contractor / Sub-contractor', section: '194C', payeeType: 'Company / Firm / Others', rate: 2,
    singleLimit: 30000, aggregateLimit: 100000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while a single payment is up to ₹30,000 and the FY aggregate is up to ₹1,00,000.' },
  { code: 'TDS-PROF', nature: 'Professional Services', section: '194J', payeeType: 'Any resident payee', rate: 10,
    singleLimit: 0, aggregateLimit: 50000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while the FY aggregate is up to ₹50,000.' },
  { code: 'TDS-TECH', nature: 'Technical Services', section: '194J', payeeType: 'Any resident payee', rate: 2,
    singleLimit: 0, aggregateLimit: 50000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while the FY aggregate is up to ₹50,000.' },
  { code: 'TDS-COM', nature: 'Commission / Brokerage', section: '194H', payeeType: 'Any resident payee', rate: 2,
    singleLimit: 0, aggregateLimit: 20000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while the FY aggregate is up to ₹20,000.' },
  { code: 'TDS-RENT-PLANT', nature: 'Rent – Plant & Machinery', section: '194-I(a)', payeeType: 'Any resident payee', rate: 2,
    singleLimit: 0, aggregateLimit: 240000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while the FY aggregate is up to ₹2,40,000.' },
  { code: 'TDS-RENT-BUILD', nature: 'Rent – Land / Building / Furniture', section: '194-I(b)', payeeType: 'Any resident payee', rate: 10,
    singleLimit: 0, aggregateLimit: 240000, thresholdBasis: 'whole',
    conditionNote: 'No TDS while the FY aggregate is up to ₹2,40,000.' },
  { code: 'TDS-INT', nature: 'Interest (other than on securities)', section: '194A', payeeType: 'Any resident payee', rate: 10,
    singleLimit: 0, aggregateLimit: 0, thresholdBasis: 'whole',
    conditionNote: 'Threshold depends on the payer / payee category — set the FY aggregate limit for your case (0 = TDS on every payment).' },
  { code: 'TDS-GOODS', nature: 'Purchase of Goods', section: '194Q', payeeType: 'Buyer / Seller', rate: 0.1,
    singleLimit: 0, aggregateLimit: 5000000, thresholdBasis: 'excess',
    conditionNote: 'TDS only on the purchase value above ₹50 lakh in the FY.' },
];
const DEFAULT_APPLICABLE_FROM = '2026-04-01';
const THRESHOLD_BASES = ['whole', 'excess', 'current'];

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}
// "Rs." (not ₹): the note is also printed in the Helvetica-based payment PDF.
function inr(value) {
  return 'Rs. ' + num(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function cleanDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

const seeding = new Map();
// Give a company its own copy of the default TDS master the first time it is used.
async function ensureCompanyTdsRules(companyId) {
  const id = Number(companyId) || 0;
  if (!id) return;
  if (!seeding.has(id)) {
    seeding.set(id, (async () => {
      const count = await TdsRule.count({ where: { companyId: id } });
      if (!count) {
        await TdsRule.bulkCreate(DEFAULT_TDS_RULES.map(rule => Object.assign(
          { applicableFrom: DEFAULT_APPLICABLE_FROM, active: true }, rule, { companyId: id }
        )));
      }
    })().finally(() => seeding.delete(id)));
  }
  await seeding.get(id);
}

function ruleAppliesOn(rule, date) {
  if (!rule || rule.active === false) return false;
  if (rule.applicableFrom && date && date < rule.applicableFrom) return false;
  if (rule.applicableTo && date && date > rule.applicableTo) return false;
  return true;
}

/* TDS for one payment under a rule, checking the slab / thresholds — not just the rate.
   prior.aggregate = gross amounts already paid by the same party under the same
   rule in the same FY; prior.untaxed = part of that on which no TDS was taken. */
function calculateTds(rule, baseAmount, prior) {
  const base = Math.max(0, round2(baseAmount));
  const rate = num(rule.rate);
  const single = num(rule.singleLimit);
  const aggregate = num(rule.aggregateLimit);
  const basis = THRESHOLD_BASES.includes(rule.thresholdBasis) ? rule.thresholdBasis : 'whole';
  const before = round2(prior && prior.aggregate);
  const untaxed = Math.max(0, round2(prior && prior.untaxed));
  const after = round2(before + base);
  const singleCrossed = single > 0 && base > single;
  const aggregateCrossed = aggregate > 0 && after > aggregate;
  const hasThreshold = single > 0 || aggregate > 0;

  let taxable = 0;
  let note;
  if (base <= 0 || rate <= 0) {
    note = rate <= 0 ? 'TDS rate is 0%' : 'No amount for TDS';
  } else if (!hasThreshold) {
    taxable = base;
    note = 'No threshold configured — TDS on the full payment';
  } else if (!singleCrossed && !aggregateCrossed) {
    const parts = [];
    if (single > 0) parts.push('this payment ' + inr(base) + ' ≤ single-payment limit ' + inr(single));
    if (aggregate > 0) parts.push('FY total ' + inr(after) + ' ≤ aggregate limit ' + inr(aggregate));
    note = 'Below threshold (' + parts.join(' and ') + ') — no TDS';
  } else if (basis === 'excess') {
    taxable = aggregateCrossed ? Math.min(base, after - Math.max(aggregate, before)) : base;
    note = 'FY total ' + inr(after) + ' is above ' + inr(aggregate) + ' — TDS on the excess ' + inr(taxable);
  } else if (basis === 'whole' && aggregateCrossed && before <= aggregate && untaxed > 0) {
    taxable = base + untaxed;
    note = 'FY total ' + inr(after) + ' crosses the aggregate limit ' + inr(aggregate) +
      ' with this payment — TDS on this payment plus ' + inr(untaxed) + ' paid earlier in the FY without TDS';
  } else if (singleCrossed && !aggregateCrossed) {
    taxable = base;
    note = 'Single payment ' + inr(base) + ' is above ' + inr(single) + ' — TDS applies';
  } else {
    taxable = base;
    note = 'FY total ' + inr(after) + ' is above the aggregate limit ' + inr(aggregate) + ' — TDS applies';
  }

  taxable = round2(taxable);
  return {
    applicable: taxable > 0 && rate > 0,
    rate,
    taxableAmount: taxable,
    tdsAmount: Math.round(taxable * rate / 100), // TDS is rounded to the nearest rupee
    singleLimit: single,
    aggregateLimit: aggregate,
    aggregateBefore: before,
    aggregateAfter: after,
    basis,
    note,
  };
}

// Company the request works on: admin → own company, superadmin → ?companyId / body.companyId.
function requestCompanyId(req) {
  if (isAdminScoped(req)) return getActorCompanyId(req);
  return Number((req.body && req.body.companyId) || req.query.companyId || 0) || null;
}

function canManage(req, rule) {
  if (!isAdminScoped(req)) return true;
  return !!getActorCompanyId(req) && Number(rule.companyId) === getActorCompanyId(req);
}

function ruleInput(body) {
  const out = {};
  if (body.code !== undefined) out.code = String(body.code || '').trim().toUpperCase().slice(0, 30);
  if (body.nature !== undefined) out.nature = String(body.nature || '').trim().slice(0, 120);
  if (body.section !== undefined) out.section = String(body.section || '').trim().slice(0, 20);
  if (body.payeeType !== undefined) out.payeeType = String(body.payeeType || '').trim().slice(0, 120);
  if (body.rate !== undefined) out.rate = num(body.rate);
  if (body.singleLimit !== undefined) out.singleLimit = Math.max(0, num(body.singleLimit));
  if (body.aggregateLimit !== undefined) out.aggregateLimit = Math.max(0, num(body.aggregateLimit));
  if (body.thresholdBasis !== undefined) out.thresholdBasis = THRESHOLD_BASES.includes(body.thresholdBasis) ? body.thresholdBasis : 'whole';
  if (body.conditionNote !== undefined) out.conditionNote = String(body.conditionNote || '');
  if (body.applicableFrom !== undefined) out.applicableFrom = cleanDate(body.applicableFrom);
  if (body.applicableTo !== undefined) out.applicableTo = cleanDate(body.applicableTo);
  if (body.active !== undefined) out.active = body.active === true || body.active === 'true';
  return out;
}

function validateRule(data) {
  if (!data.code) return 'TDS code is required';
  if (!data.nature) return 'Nature of payment is required';
  if (data.rate < 0 || data.rate > 100) return 'TDS rate must be between 0 and 100%';
  if (data.applicableFrom && data.applicableTo && data.applicableTo < data.applicableFrom) return '"Applicable to" cannot be before "applicable from"';
  return null;
}

// GET /tds-rules
exports.getTdsRules = async (req, res) => {
  try {
    const companyId = requestCompanyId(req);
    if (companyId) await ensureCompanyTdsRules(companyId);
    const where = {};
    if (isAdminScoped(req)) where.companyId = companyId || -1;
    else if (companyId) where.companyId = companyId;
    if (req.query.active === 'true') where.active = true;
    const rules = await TdsRule.findAll({
      where,
      include: [{ model: Company, as: 'company', attributes: ['id', 'name'] }],
      order: [['companyId', 'ASC'], ['code', 'ASC']],
    });
    res.json(rules);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /tds-rules
exports.createTdsRule = async (req, res) => {
  try {
    const companyId = requestCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Select a company first' });
    const data = Object.assign({ thresholdBasis: 'whole', active: true, rate: 0, singleLimit: 0, aggregateLimit: 0 }, ruleInput(req.body));
    const error = validateRule(data);
    if (error) return res.status(400).json({ message: error });
    const duplicate = await TdsRule.findOne({ where: { companyId, code: data.code } });
    if (duplicate) return res.status(400).json({ message: `TDS code ${data.code} already exists` });
    const rule = await TdsRule.create(Object.assign(data, { companyId, createdBy: req.user.id }));
    res.status(201).json(rule);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// PUT /tds-rules/:id
exports.updateTdsRule = async (req, res) => {
  try {
    const rule = await TdsRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ message: 'TDS rule not found' });
    if (!canManage(req, rule)) return res.status(403).json({ message: 'Access denied' });
    const updates = ruleInput(req.body);
    const merged = Object.assign({}, rule.toJSON(), updates);
    merged.rate = num(merged.rate);
    const error = validateRule(merged);
    if (error) return res.status(400).json({ message: error });
    if (updates.code && updates.code !== rule.code) {
      const duplicate = await TdsRule.findOne({ where: { companyId: rule.companyId, code: updates.code, id: { [Op.ne]: rule.id } } });
      if (duplicate) return res.status(400).json({ message: `TDS code ${updates.code} already exists` });
    }
    await rule.update(updates);
    res.json(rule);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /tds-rules/:id (payments keep their own copy of the rule details)
exports.deleteTdsRule = async (req, res) => {
  try {
    const rule = await TdsRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ message: 'TDS rule not found' });
    if (!canManage(req, rule)) return res.status(403).json({ message: 'Access denied' });
    await rule.destroy();
    res.json({ message: 'TDS rule deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /tds-rules/defaults — add back any default code that is missing
exports.restoreDefaultTdsRules = async (req, res) => {
  try {
    const companyId = requestCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Select a company first' });
    const existing = await TdsRule.findAll({ where: { companyId }, attributes: ['code'] });
    const codes = new Set(existing.map(r => r.code));
    const missing = DEFAULT_TDS_RULES.filter(r => !codes.has(r.code));
    if (missing.length) {
      await TdsRule.bulkCreate(missing.map(rule => Object.assign(
        { applicableFrom: DEFAULT_APPLICABLE_FROM, active: true }, rule, { companyId, createdBy: req.user.id }
      )));
    }
    res.json({ message: `${missing.length} default TDS rule(s) added`, created: missing.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

exports.DEFAULT_TDS_RULES = DEFAULT_TDS_RULES;
exports.ensureCompanyTdsRules = ensureCompanyTdsRules;
exports.calculateTds = calculateTds;
exports.ruleAppliesOn = ruleAppliesOn;
