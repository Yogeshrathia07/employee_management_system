const path = require('path');
const fs   = require('fs');
const { CompanyPolicy, User, Company } = require('../models');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documents');

// ── GET /policies ─────────────────────────────────────────────────────────────
exports.getPolicies = async (req, res) => {
  try {
    const { role, companyId } = req.user;
    let where = {};

    if (role === 'superadmin') {
      if (req.query.companyId) where.companyId = req.query.companyId;
    } else {
      where.companyId = companyId;
      where.isActive  = true;
    }

    const policies = await CompanyPolicy.findAll({
      where,
      include: [
        { model: User,    as: 'creator', attributes: ['id', 'name'] },
        { model: Company, as: 'company', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(policies);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /policies ────────────────────────────────────────────────────────────
exports.createPolicy = async (req, res) => {
  try {
    const { title, content, companyId } = req.body;
    if (!title) return res.status(400).json({ message: 'Title is required' });

    const targetCompanyId = req.user.role === 'superadmin' ? companyId : req.user.companyId;
    if (!targetCompanyId) return res.status(400).json({ message: 'Company is required' });

    const data = {
      title,
      content: content || '',
      companyId: targetCompanyId,
      createdBy: req.user.id,
      isActive:  true,
    };

    if (req.file) data.fileUrl = req.file.filename;

    const policy = await CompanyPolicy.create(data);
    const populated = await CompanyPolicy.findByPk(policy.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name'] },
        { model: Company, as: 'company', attributes: ['id', 'name'] },
      ],
    });
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /policies/:id ─────────────────────────────────────────────────────────
exports.updatePolicy = async (req, res) => {
  try {
    const policy = await CompanyPolicy.findByPk(req.params.id);
    if (!policy) return res.status(404).json({ message: 'Policy not found' });

    const { title, content, isActive } = req.body;
    if (title)              policy.title    = title;
    if (content !== undefined) policy.content = content;
    if (isActive !== undefined) policy.isActive = isActive;
    if (req.file) policy.fileUrl = req.file.filename;
    await policy.save();

    res.json(policy);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /policies/:id ──────────────────────────────────────────────────────
exports.deletePolicy = async (req, res) => {
  try {
    const policy = await CompanyPolicy.findByPk(req.params.id);
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    if (policy.fileUrl) {
      const fp = path.join(UPLOAD_DIR, policy.fileUrl);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await policy.destroy();
    res.json({ message: 'Policy deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /policies/:id/download ────────────────────────────────────────────────
exports.downloadPolicy = async (req, res) => {
  try {
    const policy = await CompanyPolicy.findByPk(req.params.id);
    if (!policy || !policy.fileUrl) return res.status(404).json({ message: 'No file attached' });
    const fp = path.join(UPLOAD_DIR, policy.fileUrl);
    if (!fs.existsSync(fp)) return res.status(404).json({ message: 'File not found' });
    res.download(fp, policy.title + '.pdf');
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /policies/:id/view ───────────────────────────────────────────────
exports.viewPolicy = async (req, res) => {
  try {
    const policy = await CompanyPolicy.findByPk(req.params.id);
    if (!policy || !policy.fileUrl) return res.status(404).json({ message: 'No file attached' });
    const fp = path.join(UPLOAD_DIR, policy.fileUrl);
    if (!fs.existsSync(fp)) return res.status(404).json({ message: 'File not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + (policy.title || 'policy') + '.pdf"');
    res.sendFile(fp);
  } catch (err) { res.status(500).json({ message: err.message }); }
};
