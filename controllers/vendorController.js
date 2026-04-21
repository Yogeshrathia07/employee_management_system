'use strict';
const { Op } = require('sequelize');
const { Vendor, PurchaseOrder, WorkOrder, Invoice } = require('../models');

function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim().toUpperCase();
  return code && code !== 'AUTO-GENERATED' ? code : prefix + '-' + Math.random().toString(36).substr(2,6).toUpperCase();
}

// ── GET /vendors ──────────────────────────────────────────────────────────────
exports.getVendors = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
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
    const v = await Vendor.findByPk(req.params.id, {
      include: [
        { model: PurchaseOrder, as: 'purchaseOrders', order: [['createdAt','DESC']] },
        { model: WorkOrder, as: 'vendorWorkOrders', order: [['createdAt','DESC']] },
      ],
    });
    if (!v) return res.status(404).json({ message: 'Vendor not found' });
    res.json(v);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /vendors ─────────────────────────────────────────────────────────────
exports.createVendor = async (req, res) => {
  try {
    const data = req.body;
    if (!data.name) return res.status(400).json({ message: 'Vendor name required' });
    data.vendorCode = cleanGeneratedCode(data.vendorCode, 'VEN');
    data.createdBy  = req.user.id;
    const v = await Vendor.create(data);
    res.status(201).json(v);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /vendors/:id ──────────────────────────────────────────────────────────
exports.updateVendor = async (req, res) => {
  try {
    const v = await Vendor.findByPk(req.params.id);
    if (!v) return res.status(404).json({ message: 'Vendor not found' });
    await v.update(req.body);
    res.json(v);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /vendors/:id ───────────────────────────────────────────────────────
exports.deleteVendor = async (req, res) => {
  try {
    const v = await Vendor.findByPk(req.params.id);
    if (!v) return res.status(404).json({ message: 'Vendor not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('vendor', v.id, req.user, v.toJSON(), v.name || 'Vendor #' + v.id);
    await v.destroy();
    res.json({ message: 'Vendor deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
