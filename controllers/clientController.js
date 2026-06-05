'use strict';
const { Op } = require('sequelize');
const { Client, Quotation, Proforma, Invoice, WorkOrder, ProjectAccount } = require('../models');
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

// ── GET /clients ──────────────────────────────────────────────────────────────
exports.getClients = async (req, res) => {
  try {
    const { q, status } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
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
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const c = await findScopedByPk(Client, 'client', req, req.params.id, {
      include: [
        { model: Quotation, as: 'quotations' },
        { model: Proforma,  as: 'proformas' },
        { model: Invoice,   as: 'clientInvoices' },
        { model: WorkOrder, as: 'clientWorkOrders' },
      ],
    }, 'Client not found');
    if (!c) return res.status(404).json({ message: 'Client not found' });
    res.json(c);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /clients ─────────────────────────────────────────────────────────────
exports.createClient = async (req, res) => {
  try {
    const data = Object.assign({}, req.body);
    if (!data.name) return res.status(400).json({ message: 'Client name required' });
    data.clientCode = cleanGeneratedCode(data.clientCode, 'CLT');
    data.companyId  = getActorCompanyId(req) || data.companyId || null;
    data.createdBy  = req.user.id;
    const c = await Client.create(data);
    res.status(201).json(c);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /clients/:id ──────────────────────────────────────────────────────────
exports.updateClient = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const c = await findScopedByPk(Client, 'client', req, req.params.id, null, 'Client not found');
    if (!c) return res.status(404).json({ message: 'Client not found' });
    const updates = Object.assign({}, req.body);
    if (getActorCompanyId(req)) updates.companyId = getActorCompanyId(req);
    await c.update(updates);
    res.json(c);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /clients/:id ───────────────────────────────────────────────────────
exports.deleteClient = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const c = await findScopedByPk(Client, 'client', req, req.params.id, null, 'Client not found');
    if (!c) return res.status(404).json({ message: 'Client not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('client', c.id, req.user, c.toJSON(), c.name || 'Client #' + c.id);
    await c.destroy();
    res.json({ message: 'Client deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
