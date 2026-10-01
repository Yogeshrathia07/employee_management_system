const { Op } = require('sequelize');
const { WorkItem, Project } = require('../models');

// Starter list an admin can load with one click from Master Data → Work Items.
const DEFAULT_WORK_ITEMS = [
  { code: 'GW-DES',   name: 'Design / Engineering',      category: 'Project Work',  billable: true },
  { code: 'GW-DRF',   name: 'Drafting / CAD',            category: 'Project Work',  billable: true },
  { code: 'GW-SITE',  name: 'Site Visit / Inspection',   category: 'Field Work',    billable: true },
  { code: 'GW-TRV',   name: 'Travel',                    category: 'Field Work',    billable: true },
  { code: 'GW-CMEET', name: 'Client Meeting',            category: 'Coordination',  billable: true },
  { code: 'GW-DOC',   name: 'Documentation / Reporting', category: 'Documentation', billable: true },
  { code: 'GW-QC',    name: 'Quality Check / Review',    category: 'Review',        billable: true },
  { code: 'GW-IMEET', name: 'Internal Meeting',          category: 'Internal',      billable: false },
  { code: 'GW-TRN',   name: 'Training / Learning',       category: 'Internal',      billable: false },
  { code: 'GW-ADM',   name: 'Administration',            category: 'Internal',      billable: false },
];

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 150);
}

// Company the request works on: admins are fixed to their company,
// superadmin passes ?companyId / body.companyId.
function targetCompanyId(req) {
  if (req.user.role === 'superadmin') {
    const requested = Number((req.body && req.body.companyId) || req.query.companyId || 0);
    return requested > 0 ? requested : null;
  }
  return req.user.companyId || null;
}

function canManage(req, item) {
  if (req.user.role === 'superadmin') return true;
  return req.user.role === 'admin' && !!req.user.companyId && Number(item.companyId) === Number(req.user.companyId);
}

// GET /work-items
exports.getWorkItems = async (req, res) => {
  try {
    const where = {};
    const companyId = targetCompanyId(req);
    if (req.user.role !== 'superadmin') where.companyId = companyId || -1;
    else if (companyId) where.companyId = companyId;
    if (req.query.status) where.status = req.query.status;
    const items = await WorkItem.findAll({ where, order: [['category', 'ASC'], ['name', 'ASC']] });
    res.json(items);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /work-items
exports.createWorkItem = async (req, res) => {
  try {
    const name = cleanText(req.body.name);
    if (!name) return res.status(400).json({ message: 'Work item name is required' });
    const companyId = targetCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Select a company first' });
    const duplicate = await WorkItem.findOne({ where: { companyId, name } });
    if (duplicate) return res.status(400).json({ message: 'A work item with this name already exists' });
    const item = await WorkItem.create({
      code: cleanText(req.body.code, 30),
      name,
      category: cleanText(req.body.category, 60),
      description: req.body.description || '',
      billable: req.body.billable !== false && req.body.billable !== 'false',
      status: req.body.status === 'inactive' ? 'inactive' : 'active',
      companyId,
      createdBy: req.user.id,
    });
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// PUT /work-items/:id
exports.updateWorkItem = async (req, res) => {
  try {
    const item = await WorkItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Work item not found' });
    if (!canManage(req, item)) return res.status(403).json({ message: 'Access denied' });
    if (req.body.name !== undefined) {
      const name = cleanText(req.body.name);
      if (!name) return res.status(400).json({ message: 'Work item name is required' });
      const duplicate = await WorkItem.findOne({ where: { companyId: item.companyId, name, id: { [Op.ne]: item.id } } });
      if (duplicate) return res.status(400).json({ message: 'A work item with this name already exists' });
      item.name = name;
    }
    if (req.body.code !== undefined) item.code = cleanText(req.body.code, 30);
    if (req.body.category !== undefined) item.category = cleanText(req.body.category, 60);
    if (req.body.description !== undefined) item.description = req.body.description || '';
    if (req.body.billable !== undefined) item.billable = req.body.billable !== false && req.body.billable !== 'false';
    if (req.body.status !== undefined) item.status = req.body.status === 'inactive' ? 'inactive' : 'active';
    await item.save();
    res.json(item);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /work-items/:id
exports.deleteWorkItem = async (req, res) => {
  try {
    const item = await WorkItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Work item not found' });
    if (!canManage(req, item)) return res.status(403).json({ message: 'Access denied' });
    await item.destroy();
    res.json({ message: 'Work item deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /work-items/defaults — adds the starter list (skips names that exist)
exports.addDefaultWorkItems = async (req, res) => {
  try {
    const companyId = targetCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Select a company first' });
    const existing = await WorkItem.findAll({ where: { companyId }, attributes: ['name'] });
    const names = new Set(existing.map(i => i.name.toLowerCase()));
    const toCreate = DEFAULT_WORK_ITEMS
      .filter(i => !names.has(i.name.toLowerCase()))
      .map(i => Object.assign({}, i, { companyId, status: 'active', createdBy: req.user.id }));
    if (toCreate.length) await WorkItem.bulkCreate(toCreate);
    res.json({ message: `${toCreate.length} default work item(s) added`, created: toCreate.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /master-data/options — active projects + work items for timesheet entry
exports.getTimesheetOptions = async (req, res) => {
  try {
    let companyId = req.user.companyId || null;
    if (req.user.role === 'superadmin') companyId = Number(req.query.companyId || 0) || null;
    const scope = companyId ? { companyId } : (req.user.role === 'superadmin' ? {} : { companyId: -1 });
    const [projects, workItems] = await Promise.all([
      Project.findAll({
        where: Object.assign({ status: 'active' }, scope),
        attributes: ['id', 'code', 'name', 'clientName', 'location', 'managerId'],
        order: [['name', 'ASC']],
      }),
      WorkItem.findAll({
        where: Object.assign({ status: 'active' }, scope),
        attributes: ['id', 'code', 'name', 'category', 'billable'],
        order: [['category', 'ASC'], ['name', 'ASC']],
      }),
    ]);
    res.json({ projects, workItems });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
