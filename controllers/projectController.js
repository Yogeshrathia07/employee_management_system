const { Project, User } = require('../models');

const managerInclude = { model: User, as: 'manager', attributes: ['id', 'name', 'email', 'department', 'position'] };
const creatorInclude = { model: User, as: 'creator', attributes: ['id', 'name'] };

const PROJECT_STATUSES = ['active', 'on_hold', 'completed'];

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 200);
}

function cleanDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Admins manage only their own company's projects; superadmin manages all.
function canManage(req, project) {
  if (req.user.role === 'superadmin') return true;
  return req.user.role === 'admin' && !!req.user.companyId && Number(project.companyId) === Number(req.user.companyId);
}

async function validateManager(managerId, companyId) {
  if (!managerId) return null;
  const manager = await User.findByPk(managerId, { attributes: ['id', 'companyId', 'role'] });
  if (!manager) return 'Selected manager not found';
  if (companyId && manager.companyId && Number(manager.companyId) !== Number(companyId)) {
    return 'Selected manager belongs to another company';
  }
  return null;
}

// GET /projects
exports.getProjects = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    let where = {};

    if (role === 'manager') {
      where.managerId = id;
    } else if (role === 'superadmin') {
      if (req.query.companyId) where.companyId = req.query.companyId;
    } else {
      where.companyId = companyId;
    }

    if (req.query.status) where.status = req.query.status;

    const projects = await Project.findAll({
      where,
      include: [managerInclude, creatorInclude],
      order: [['createdAt', 'DESC']],
    });
    res.json(projects);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// POST /projects  (admin: own company, superadmin: any company)
exports.createProject = async (req, res) => {
  try {
    const { name, description, managerId, status } = req.body;
    if (!cleanText(name)) return res.status(400).json({ message: 'Project name is required' });
    if (req.user.role === 'admin' && !req.user.companyId) {
      return res.status(400).json({ message: 'Admin account is not associated with a company' });
    }
    const companyId = req.user.role === 'admin'
      ? req.user.companyId
      : (Number(req.body.companyId) || req.user.companyId || null);
    const managerError = await validateManager(managerId, companyId);
    if (managerError) return res.status(400).json({ message: managerError });

    const project = await Project.create({
      code:        cleanText(req.body.code, 30),
      name:        cleanText(name),
      description: description || '',
      clientName:  cleanText(req.body.clientName),
      location:    cleanText(req.body.location),
      startDate:   cleanDate(req.body.startDate),
      endDate:     cleanDate(req.body.endDate),
      managerId:   managerId || null,
      companyId,
      status:      PROJECT_STATUSES.includes(status) ? status : 'active',
      createdBy:   req.user.id,
    });
    const populated = await Project.findByPk(project.id, { include: [managerInclude, creatorInclude] });
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// PUT /projects/:id
exports.updateProject = async (req, res) => {
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canManage(req, project)) return res.status(403).json({ message: 'Access denied' });

    const { name, description, managerId, companyId, status } = req.body;
    if (name !== undefined) {
      if (!cleanText(name)) return res.status(400).json({ message: 'Project name is required' });
      project.name = cleanText(name);
    }
    if (description !== undefined) project.description = description;
    ['code', 'clientName', 'location'].forEach(field => {
      if (req.body[field] !== undefined) project[field] = cleanText(req.body[field], field === 'code' ? 30 : 200);
    });
    if (req.body.startDate !== undefined) project.startDate = cleanDate(req.body.startDate);
    if (req.body.endDate !== undefined) project.endDate = cleanDate(req.body.endDate);
    if (companyId !== undefined && req.user.role === 'superadmin') project.companyId = companyId || null;
    if (managerId !== undefined) {
      const managerError = await validateManager(managerId, project.companyId);
      if (managerError) return res.status(400).json({ message: managerError });
      project.managerId = managerId || null;
    }
    if (status !== undefined && PROJECT_STATUSES.includes(status)) project.status = status;
    await project.save();

    const populated = await Project.findByPk(project.id, { include: [managerInclude, creatorInclude] });
    res.json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /projects/:id
exports.deleteProject = async (req, res) => {
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canManage(req, project)) return res.status(403).json({ message: 'Access denied' });
    await project.destroy();
    res.json({ message: 'Project deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
