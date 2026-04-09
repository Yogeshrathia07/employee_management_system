'use strict';
const { Op } = require('sequelize');
const { ProjectAccount, PurchaseOrder, Invoice, WorkOrder, Client } = require('../models');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

// ── GET /project-accounts ─────────────────────────────────────────────────────
exports.getProjectAccounts = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { name:        { [Op.like]: `%${q}%` } },
      { projectCode: { [Op.like]: `%${q}%` } },
      { clientName:  { [Op.like]: `%${q}%` } },
    ];
    const rows = await ProjectAccount.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Client, as: 'client', attributes: ['id','name','clientCode'], required: false },
        { model: PurchaseOrder, as: 'purchaseOrders', attributes: ['id','totalAmount'] },
        { model: Invoice, as: 'invoices', attributes: ['id','totalAmount'] },
      ],
    });
    // compute spent for each project
    const result = rows.map(r => {
      const plain = r.toJSON();
      const poSpent = (plain.purchaseOrders || []).reduce((s, po) => s + parseFloat(po.totalAmount || 0), 0);
      const invBilled = (plain.invoices || []).reduce((s, inv) => s + parseFloat(inv.totalAmount || 0), 0);
      plain.spent = poSpent;
      plain.billed = invBilled;
      plain.remaining = parseFloat(plain.budget || 0) - poSpent;
      return plain;
    });
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /project-accounts/:id ─────────────────────────────────────────────────
exports.getProjectAccount = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id, {
      include: [
        { model: Client, as: 'client', required: false },
        { model: PurchaseOrder, as: 'purchaseOrders' },
        { model: Invoice, as: 'invoices' },
        { model: WorkOrder, as: 'workOrders' },
      ],
    });
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });
    const plain = pa.toJSON();
    plain.spent = (plain.purchaseOrders || []).reduce((s, po) => s + parseFloat(po.totalAmount || 0), 0);
    plain.billed = (plain.invoices || []).reduce((s, inv) => s + parseFloat(inv.totalAmount || 0), 0);
    plain.remaining = parseFloat(plain.budget || 0) - plain.spent;
    res.json(plain);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /project-accounts ────────────────────────────────────────────────────
exports.createProjectAccount = async (req, res) => {
  try {
    const data = req.body;
    if (!data.name) return res.status(400).json({ message: 'Project name required' });
    data.projectCode = 'PRJ-' + genCode();
    data.createdBy = req.user.id;
    // auto-fill clientName
    if (data.clientId && !data.clientName) {
      const c = await Client.findByPk(data.clientId);
      if (c) data.clientName = c.name;
    }
    const pa = await ProjectAccount.create(data);
    res.status(201).json(pa);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /project-accounts/:id ─────────────────────────────────────────────────
exports.updateProjectAccount = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id);
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });
    await pa.update(req.body);
    res.json(pa);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /project-accounts/:id ──────────────────────────────────────────────
exports.deleteProjectAccount = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id);
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('project_account', pa.id, req.user, pa.toJSON(), pa.name);
    await pa.destroy();
    res.json({ message: 'Project Account deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
