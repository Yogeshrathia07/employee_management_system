'use strict';
const { Op } = require('sequelize');
const { Quotation, Proforma, Invoice, Client } = require('../models');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

// ── GET /quotations ───────────────────────────────────────────────────────────
exports.getQuotations = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { quotationNumber: { [Op.like]: `%${q}%` } },
      { clientName:      { [Op.like]: `%${q}%` } },
    ];
    const rows = await Quotation.findAll({ where, order: [['createdAt','DESC']],
      include: [{ model: Client, as: 'client', attributes: ['id','name','clientCode'] }] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /quotations/:id ──────────────────────────────────────────────────────
exports.getQuotation = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id, {
      include: [{ model: Client, as: 'client' }]
    });
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    res.json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations ─────────────────────────────────────────────────────────
exports.createQuotation = async (req, res) => {
  try {
    const data = req.body;
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.clientName) return res.status(400).json({ message: 'Client name required' });
    data.quotationNumber = 'QUO-' + genCode();
    data.createdBy = req.user.id;
    const q = await Quotation.create(data);
    res.status(201).json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /quotations/:id ──────────────────────────────────────────────────────
exports.updateQuotation = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    await q.update(req.body);
    res.json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /quotations/:id ───────────────────────────────────────────────────
exports.deleteQuotation = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('quotation', q.id, req.user, q.toJSON(), q.quotationNumber);
    await q.destroy();
    res.json({ message: 'Quotation deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations/:id/convert-to-proforma ─────────────────────────────────
exports.convertToProforma = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });

    const pro = await Proforma.create({
      proformaNumber: 'PRO-' + genCode(),
      clientId:       q.clientId,
      sourceQuotationId: q.id,
      customerName:      q.clientName,
      customerGstin:     q.clientGstin,
      customerPan:       q.clientPan,
      customerEmail:     q.clientEmail,
      customerAddress:   q.clientAddress,
      customerState:     q.clientState,
      customerStateCode: q.clientStateCode,
      sellerName:        q.sellerName,
      sellerGstin:       q.sellerGstin,
      sellerAddress:     q.sellerAddress,
      sellerState:       q.sellerState,
      sellerStateCode:   q.sellerStateCode,
      sellerPhone:       q.sellerPhone,
      sellerEmail:       q.sellerEmail,
      sellerPan:         q.sellerPan,
      date:          q.date,
      validityDate:  q.validTill,
      items:         q.items,
      sgstRate:      q.sgstRate,
      cgstRate:      q.cgstRate,
      subtotal:      q.subtotal,
      totalCgst:     q.totalCgst,
      totalSgst:     q.totalSgst,
      totalIgst:     q.totalIgst,
      totalTax:      q.totalTax,
      roundOff:      q.roundOff,
      totalAmount:   q.totalAmount,
      bankName:      q.bankName,
      bankAcName:    q.bankAcName,
      bankAccount:   q.bankAccount,
      bankIfsc:      q.bankIfsc,
      bankBranch:    q.bankBranch,
      notes:         q.notes,
      termsConditions: q.termsConditions,
      status:        'Draft',
      createdBy:     req.user.id,
    });

    await q.update({ status: 'Converted', convertedToId: pro.id, convertedToType: 'proforma' });
    res.status(201).json(pro);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations/:id/convert-to-invoice ──────────────────────────────────
exports.convertToInvoice = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });

    const inv = await Invoice.create({
      invoiceNumber:  'INV-' + genCode(),
      invoiceDate:    q.date,
      clientId:       q.clientId,
      customerName:   q.clientName,
      customerGstin:  q.clientGstin,
      customerPan:    q.clientPan,
      customerEmail:  q.clientEmail,
      customerAddress:q.clientAddress,
      customerState:  q.clientState,
      customerStateCode: q.clientStateCode,
      sellerName:     q.sellerName,
      sellerGstin:    q.sellerGstin,
      sellerAddress:  q.sellerAddress,
      sellerState:    q.sellerState,
      sellerStateCode:q.sellerStateCode,
      sellerPhone:    q.sellerPhone,
      sellerEmail:    q.sellerEmail,
      sellerPan:      q.sellerPan,
      items:          q.items,
      sgstRate:       q.sgstRate,
      cgstRate:       q.cgstRate,
      subtotal:       q.subtotal,
      totalCgst:      q.totalCgst,
      totalSgst:      q.totalSgst,
      totalIgst:      q.totalIgst,
      totalTax:       q.totalTax,
      roundOff:       q.roundOff,
      totalAmount:    q.totalAmount,
      bankName:       q.bankName,
      bankAcName:     q.bankAcName,
      bankAccount:    q.bankAccount,
      bankIfsc:       q.bankIfsc,
      bankBranch:     q.bankBranch,
      notes:          q.notes,
      termsConditions:q.termsConditions,
      sourceDocId:    q.id,
      sourceDocType:  'quotation',
      convertedBadge: 'From Quotation',
      status:         'Draft',
      createdBy:      req.user.id,
    });

    await q.update({ status: 'Converted', convertedToId: inv.id, convertedToType: 'invoice' });
    res.status(201).json(inv);
  } catch (err) { res.status(500).json({ message: err.message }); }
};
