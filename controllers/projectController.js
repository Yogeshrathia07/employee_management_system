const { Project, User } = require('../models');
const { Op } = require('sequelize');

const managerInclude = { model: User, as: 'manager', attributes: ['id', 'name', 'email', 'department', 'position'] };
const creatorInclude = { model: User, as: 'creator', attributes: ['id', 'name'] };

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

// POST /projects  (superadmin only)
exports.createProject = async (req, res) => {
  try {
    const { name, description, managerId, companyId, status } = req.body;
    if (!name || !managerId) return res.status(400).json({ message: 'Name and manager are required' });

    const project = await Project.create({
      name: name.trim(),
      description: description || '',
      managerId,
      companyId: companyId || req.user.companyId || null,
      status: status || 'active',
      createdBy: req.user.id,
    });
    const populated = await Project.findByPk(project.id, { include: [managerInclude, creatorInclude] });
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// PUT /projects/:id  (superadmin only)
exports.updateProject = async (req, res) => {
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const { name, description, managerId, companyId, status } = req.body;
    if (name        !== undefined) project.name        = name.trim();
    if (description !== undefined) project.description = description;
    if (managerId   !== undefined) project.managerId   = managerId;
    if (companyId   !== undefined) project.companyId   = companyId;
    if (status      !== undefined) project.status      = status;
    await project.save();

    const populated = await Project.findByPk(project.id, { include: [managerInclude, creatorInclude] });
    res.json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// DELETE /projects/:id  (superadmin only)
exports.deleteProject = async (req, res) => {
  try {
    const project = await Project.findByPk(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    await project.destroy();
    res.json({ message: 'Project deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
