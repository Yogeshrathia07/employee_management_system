'use strict';
const { Op } = require('sequelize');
const { Vendor, PurchaseOrder, WorkOrder, Invoice } = require('../models');
const {
  applyCompanyScope,
  findScopedByPk,
  getActorCompanyId,
  syncAccountsCompanyIds,
} = require('./accountsCompanyScope');

function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim();
  return code && code.toLowerCase() !== 'auto-generated' ? code : prefix + '-' + Math.random().toString(36).substr(2,6).toUpperCase();
}

// ── GET /vendors ──────────────────────────────────────────────────────────────
exports.getVendors = async (req, res) => {
  try {
    const { q, status } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { name:   { [Op.like]: `%${q}%` } },
      { gstin:  { [Op.like]: `%${q}%` } },
      { vendorCode: { [Op.like]: `%${q}%` } },
      { email:  { [Op.like]: `%${q}%` } },
    ];
    const rows = await Vendor.findAll({ where, order: [['createdAt','DESC']] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /vendors/:id ──────────────────────────────────────────────────────────
exports.getVendor = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const v = await findScopedByPk(Vendor, 'vendor', req, req.params.id, {
      include: [
        { model: PurchaseOrder, as: 'purchaseOrders', order: [['createdAt','DESC']] },
        { model: WorkOrder, as: 'vendorWorkOrders', order: [['createdAt','DESC']] },
      ],
    }, 'Vendor not found');
    if (!v) return res.status(404).json({ message: 'Vendor not found' });
    res.json(v);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /vendors ─────────────────────────────────────────────────────────────
exports.createVendor = async (req, res) => {
  try {
    const data = Object.assign({}, req.body);
    if (!data.name) return res.status(400).json({ message: 'Vendor name required' });
    data.vendorCode = cleanGeneratedCode(data.vendorCode, 'VEN');
    data.companyId = getActorCompanyId(req) || data.companyId || null;
    data.createdBy  = req.user.id;
    const v = await Vendor.create(data);
    res.status(201).json(v);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /vendors/:id ──────────────────────────────────────────────────────────
exports.updateVendor = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const v = await findScopedByPk(Vendor, 'vendor', req, req.params.id, null, 'Vendor not found');
    if (!v) return res.status(404).json({ message: 'Vendor not found' });
    const updates = Object.assign({}, req.body);
    if (getActorCompanyId(req)) updates.companyId = getActorCompanyId(req);
    await v.update(updates);
    res.json(v);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /vendors/:id ───────────────────────────────────────────────────────
exports.deleteVendor = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const v = await findScopedByPk(Vendor, 'vendor', req, req.params.id, null, 'Vendor not found');
    if (!v) return res.status(404).json({ message: 'Vendor not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('vendor', v.id, req.user, v.toJSON(), v.name || 'Vendor #' + v.id);
    await v.destroy();
    res.json({ message: 'Vendor deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
