'use strict';
const { Op } = require('sequelize');
const { WorkOrder, Client, Vendor, ProjectAccount } = require('../models');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

// ── GET /work-orders ──────────────────────────────────────────────────────────
exports.getWorkOrders = async (req, res) => {
  try {
    const { q, status, type } = req.query;
    const where = {};
    if (type)   where.type = type;
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { woNumber:  { [Op.like]: `%${q}%` } },
      { partyName: { [Op.like]: `%${q}%` } },
      { projectName: { [Op.like]: `%${q}%` } },
    ];
    const rows = await WorkOrder.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Client, as: 'client', attributes: ['id','name','clientCode'], required: false },
        { model: Vendor, as: 'vendor', attributes: ['id','name','vendorCode'], required: false },
        { model: ProjectAccount, as: 'projectAccount', attributes: ['id','name','projectCode'], required: false },
      ],
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /work-orders/:id ──────────────────────────────────────────────────────
exports.getWorkOrder = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, {
      include: [
        { model: Client, as: 'client', required: false },
        { model: Vendor, as: 'vendor', required: false },
        { model: ProjectAccount, as: 'projectAccount', required: false },
      ],
    });
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });
    res.json(wo);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /work-orders ─────────────────────────────────────────────────────────
exports.createWorkOrder = async (req, res) => {
  try {
    const data = req.body;
    if (!data.type) return res.status(400).json({ message: 'Type (CWO/VWO) required' });
    if (!data.partyName && !data.clientId && !data.vendorId) {
      return res.status(400).json({ message: 'Party (client or vendor) required' });
    }
    data.woNumber = (data.type === 'CWO' ? 'CWO-' : 'VWO-') + genCode();
    data.createdBy = req.user.id;
    // auto-fill partyName
    if (data.type === 'CWO' && data.clientId && !data.partyName) {
      const c = await Client.findByPk(data.clientId);
      if (c) data.partyName = c.name;
    }
    if (data.type === 'VWO' && data.vendorId && !data.partyName) {
      const v = await Vendor.findByPk(data.vendorId);
      if (v) data.partyName = v.name;
    }
    const wo = await WorkOrder.create(data);
    res.status(201).json(wo);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /work-orders/:id ──────────────────────────────────────────────────────
exports.updateWorkOrder = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });
    await wo.update(req.body);
    res.json(wo);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /work-orders/:id ───────────────────────────────────────────────────
exports.deleteWorkOrder = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin(wo.type === 'CWO' ? 'client_work_order' : 'vendor_work_order',
      wo.id, req.user, wo.toJSON(), wo.woNumber);
    await wo.destroy();
    res.json({ message: 'Work Order deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
