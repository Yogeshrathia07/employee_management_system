const { Company, User } = require('../models');

exports.getCompanies = async (req, res) => {
  try {
    const companies = await Company.findAll({ order: [['createdAt', 'DESC']] });
    res.json(companies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCompanyStats = async (req, res) => {
  try {
    const companies = await Company.findAll();
    const stats = await Promise.all(companies.map(async (c) => {
      const userCount = await User.count({ where: { companyId: c.id } });
      return { ...c.toJSON(), userCount };
    }));
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createCompany = async (req, res) => {
  try {
    const { name, email, phone, industry, address, status, logoUrl, authorizedSignatory, panNo, gstNo } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });
    const company = await Company.create({ name, email, phone, industry, address, status, logoUrl, authorizedSignatory, panNo, gstNo });
    res.status(201).json(company);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateOwnCompany = async (req, res) => {
  try {
    const { companyId } = req.user;
    if (!companyId) return res.status(400).json({ message: 'No company associated' });
    const company = await Company.findByPk(companyId);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const { currency } = req.body;
    if (currency) company.currency = currency;
    await company.save();
    res.json(company);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateCompany = async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    await company.update(req.body);
    res.json(company);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteCompany = async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    await company.destroy();
    res.json({ message: 'Company deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /companies/:id/logo — upload company logo image
exports.uploadLogo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });

    // Delete old logo if exists
    if (company.logoUrl && !company.logoUrl.startsWith('http')) {
      const fs = require('fs');
      const path = require('path');
      const oldPath = path.join(__dirname, '..', 'uploads', 'photos', company.logoUrl);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    company.logoUrl = req.file.filename;
    await company.save();
    res.json({ message: 'Logo uploaded', logoUrl: req.file.filename });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /companies/:id/logo — serve company logo
exports.getLogo = async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const company = await Company.findByPk(req.params.id);
    if (!company || !company.logoUrl) return res.status(404).json({ message: 'No logo' });

    // If it's a URL, redirect
    if (company.logoUrl.startsWith('http')) return res.redirect(company.logoUrl);

    const filePath = path.join(__dirname, '..', 'uploads', 'photos', company.logoUrl);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found' });
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
