'use strict';
const { Op } = require('sequelize');
const { PurchaseOrder, Vendor, ProjectAccount } = require('../models');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

// ── GET /purchase-orders ──────────────────────────────────────────────────────
exports.getPurchaseOrders = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { poNumber:   { [Op.like]: `%${q}%` } },
      { vendorName: { [Op.like]: `%${q}%` } },
    ];
    const rows = await PurchaseOrder.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Vendor, as: 'vendor', attributes: ['id','name','vendorCode','gstin'] },
        { model: ProjectAccount, as: 'projectAccount', attributes: ['id','name','projectCode'] },
      ] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /purchase-orders/:id ──────────────────────────────────────────────────
exports.getPurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id, {
      include: [
        { model: Vendor, as: 'vendor' },
        { model: ProjectAccount, as: 'projectAccount' },
      ],
    });
    if (!po) return res.status(404).json({ message: 'PO not found' });
    res.json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /purchase-orders ─────────────────────────────────────────────────────
exports.createPurchaseOrder = async (req, res) => {
  try {
    const data = req.body;
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.vendorName && !data.vendorId) return res.status(400).json({ message: 'Vendor required' });
    data.poNumber = 'PO-' + genCode();
    data.createdBy = req.user.id;
    // auto-fill vendorName from vendorId if provided
    if (data.vendorId && !data.vendorName) {
      const v = await Vendor.findByPk(data.vendorId);
      if (v) data.vendorName = v.name;
    }
    const po = await PurchaseOrder.create(data);
    res.status(201).json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /purchase-orders/:id ──────────────────────────────────────────────────
exports.updatePurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'PO not found' });
    await po.update(req.body);
    res.json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /purchase-orders/:id ───────────────────────────────────────────────
exports.deletePurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'PO not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('purchase_order', po.id, req.user, po.toJSON(), po.poNumber);
    await po.destroy();
    res.json({ message: 'Purchase Order deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
