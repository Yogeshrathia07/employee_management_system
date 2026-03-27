const { Op } = require('sequelize');
const { Timesheet, User } = require('../models');

exports.getTimesheets = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    let where = {};

    if (role === 'employee') {
      where.userId = id;
    } else if (role === 'manager') {
      if (req.query.scope === 'own') {
        where.userId = id;
      } else if (req.query.scope === 'team') {
        const teamMembers = await User.findAll({ where: { managerId: id }, attributes: ['id'] });
        where.userId = { [Op.in]: teamMembers.map(m => m.id) };
      } else {
        const teamMembers = await User.findAll({ where: { managerId: id }, attributes: ['id'] });
        where.userId = { [Op.in]: [...teamMembers.map(m => m.id), id] };
      }
    } else if (role === 'admin') {
      const companyUsers = await User.findAll({ where: { companyId }, attributes: ['id'] });
      where.userId = { [Op.in]: companyUsers.map(u => u.id) };
    }

    // superadmin can filter by companyId
    if (req.user.role === 'superadmin' && req.query.companyId) {
      const companyUsers = await User.findAll({ where: { companyId: req.query.companyId }, attributes: ['id'] });
      where.userId = { [Op.in]: companyUsers.map(u => u.id) };
    }

    const timesheets = await Timesheet.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'approver', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(timesheets);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Check if timesheet already exists for overlapping dates
exports.checkExisting = async (req, res) => {
  try {
    const { weekStart, weekEnd } = req.query;
    if (!weekStart || !weekEnd) return res.json({ exists: false });
    const existing = await Timesheet.findOne({
      where: {
        userId: req.user.id,
        weekStart: { [Op.lte]: new Date(weekEnd) },
        weekEnd: { [Op.gte]: new Date(weekStart) },
      },
    });
    res.json({ exists: !!existing, timesheet: existing || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createTimesheet = async (req, res) => {
  try {
    const { weekStart, weekEnd, entries, notes } = req.body;
    const totalHours = (entries || []).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);

    // Check for overlapping timesheet
    const existing = await Timesheet.findOne({
      where: {
        userId: req.user.id,
        weekStart: { [Op.lte]: new Date(weekEnd) },
        weekEnd: { [Op.gte]: new Date(weekStart) },
      },
    });
    if (existing) {
      return res.status(400).json({ message: 'A timesheet already exists for this period. Please edit the existing one instead.', existingId: existing.id });
    }

    const timesheet = await Timesheet.create({
      userId: req.user.id,
      companyId: req.user.companyId,
      weekStart: new Date(weekStart),
      weekEnd: new Date(weekEnd),
      entries: entries || [],
      totalHours,
      notes,
    });
    res.status(201).json(timesheet);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /timesheets/:id — edit existing timesheet (resets to pending)
exports.updateTimesheet = async (req, res) => {
  try {
    const ts = await Timesheet.findByPk(req.params.id);
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    if (ts.userId !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { entries, notes } = req.body;
    if (entries) {
      ts.entries = entries;
      ts.totalHours = entries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
    }
    if (notes !== undefined) ts.notes = notes;

    // Reset to pending for re-approval
    ts.status = 'pending';
    ts.approvedBy = null;
    ts.approvedAt = null;
    ts.rejectionReason = '';

    await ts.save();

    const updated = await Timesheet.findByPk(ts.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'approver', attributes: ['id', 'name'] },
      ],
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.actionTimesheet = async (req, res) => {
  try {
    const { action, rejectionReason } = req.body;
    const ts = await Timesheet.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'role', 'managerId'] }],
    });
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    if (ts.status !== 'pending') return res.status(400).json({ message: 'Timesheet already processed' });

    const actor = req.user;
    const submitter = ts.user;

    if (submitter.id === actor.id) {
      return res.status(403).json({ message: 'Cannot approve your own timesheet' });
    }

    if (actor.role === 'manager') {
      if (submitter.role === 'manager') {
        return res.status(403).json({ message: 'Cannot approve another manager\'s timesheet. Needs admin or superadmin approval.' });
      }
      if (submitter.managerId !== actor.id) {
        return res.status(403).json({ message: 'Not your team member' });
      }
    }

    ts.status = action === 'approve' ? 'approved' : 'rejected';
    ts.approvedBy = actor.id;
    ts.approvedAt = new Date();
    if (rejectionReason) ts.rejectionReason = rejectionReason;
    await ts.save();

    const updated = await Timesheet.findByPk(ts.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'approver', attributes: ['id', 'name'] },
      ],
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteTimesheet = async (req, res) => {
  try {
    const ts = await Timesheet.findByPk(req.params.id);
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    if (ts.userId !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (ts.status === 'approved') return res.status(400).json({ message: 'Cannot delete approved timesheet' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('timesheet', ts.id, req.user, ts.toJSON(), 'Timesheet ' + ts.id);
    await ts.destroy();
    res.json({ message: 'Timesheet deleted (moved to recycle bin)' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
