const { SpreadsheetWorkbook } = require('../models');

// GET /api/spreadsheet — list all workbooks for current user
exports.getWorkbooks = async (req, res) => {
  try {
    const where = { userId: req.user.id };
    const workbooks = await SpreadsheetWorkbook.findAll({
      where,
      attributes: ['id', 'name', 'activeSheet', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
    });
    res.json(workbooks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/spreadsheet/:id — get a single workbook
exports.getWorkbook = async (req, res) => {
  try {
    const wb = await SpreadsheetWorkbook.findOne({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!wb) return res.status(404).json({ message: 'Workbook not found' });
    res.json(wb);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/spreadsheet — create new workbook
exports.createWorkbook = async (req, res) => {
  try {
    const { name, sheetsData, activeSheet } = req.body;
    const wb = await SpreadsheetWorkbook.create({
      userId:      req.user.id,
      companyId:   req.user.companyId || null,
      name:        name || 'Workbook 1',
      sheetsData:  sheetsData || [],
      activeSheet: activeSheet || 'Sheet1',
    });
    res.status(201).json(wb);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/spreadsheet/:id — update workbook
exports.updateWorkbook = async (req, res) => {
  try {
    const wb = await SpreadsheetWorkbook.findOne({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!wb) return res.status(404).json({ message: 'Workbook not found' });

    const { name, sheetsData, activeSheet } = req.body;
    if (name        !== undefined) wb.name        = name;
    if (sheetsData  !== undefined) wb.sheetsData  = sheetsData;
    if (activeSheet !== undefined) wb.activeSheet = activeSheet;

    await wb.save();
    res.json({ id: wb.id, name: wb.name, activeSheet: wb.activeSheet, updatedAt: wb.updatedAt });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/spreadsheet/:id — delete workbook
exports.deleteWorkbook = async (req, res) => {
  try {
    const wb = await SpreadsheetWorkbook.findOne({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!wb) return res.status(404).json({ message: 'Workbook not found' });
    await wb.destroy();
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
