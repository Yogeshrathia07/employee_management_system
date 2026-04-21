'use strict';
const { Op } = require('sequelize');
const { Client, Quotation, Proforma, Invoice, WorkOrder, ProjectAccount } = require('../models');

function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim().toUpperCase();
  return code && code !== 'AUTO-GENERATED' ? code : prefix + '-' + Math.random().toString(36).substr(2,6).toUpperCase();
}

// ── GET /clients ──────────────────────────────────────────────────────────────
exports.getClients = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { name:       { [Op.like]: `%${q}%` } },
      { gstin:      { [Op.like]: `%${q}%` } },
      { clientCode: { [Op.like]: `%${q}%` } },
      { email:      { [Op.like]: `%${q}%` } },
    ];
    const rows = await Client.findAll({ where, order: [['createdAt','DESC']] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /clients/:id ──────────────────────────────────────────────────────────
exports.getClient = async (req, res) => {
  try {
    const c = await Client.findByPk(req.params.id, {
      include: [
        { model: Quotation, as: 'quotations' },
        { model: Proforma,  as: 'proformas' },
        { model: Invoice,   as: 'clientInvoices' },
        { model: WorkOrder, as: 'clientWorkOrders' },
      ],
    });
    if (!c) return res.status(404).json({ message: 'Client not found' });
    res.json(c);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /clients ─────────────────────────────────────────────────────────────
exports.createClient = async (req, res) => {
  try {
    const data = req.body;
    if (!data.name) return res.status(400).json({ message: 'Client name required' });
    data.clientCode = cleanGeneratedCode(data.clientCode, 'CLT');
    data.createdBy  = req.user.id;
    const c = await Client.create(data);
    res.status(201).json(c);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /clients/:id ──────────────────────────────────────────────────────────
exports.updateClient = async (req, res) => {
  try {
    const c = await Client.findByPk(req.params.id);
    if (!c) return res.status(404).json({ message: 'Client not found' });
    await c.update(req.body);
    res.json(c);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /clients/:id ───────────────────────────────────────────────────────
exports.deleteClient = async (req, res) => {
  try {
    const c = await Client.findByPk(req.params.id);
    if (!c) return res.status(404).json({ message: 'Client not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('client', c.id, req.user, c.toJSON(), c.name || 'Client #' + c.id);
    await c.destroy();
    res.json({ message: 'Client deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
