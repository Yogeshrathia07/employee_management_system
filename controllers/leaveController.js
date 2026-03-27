const { Op } = require('sequelize');
const { Leave, User } = require('../models');

const VALID_LEAVE_TYPES = ['earned', 'casual', 'sick', 'maternity', 'paternity', 'unpaid', 'other'];

exports.getLeaves = async (req, res) => {
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
    // superadmin sees all — but can filter by companyId
    if (role === 'superadmin' && req.query.companyId) {
      const companyUsers = await User.findAll({ where: { companyId: req.query.companyId }, attributes: ['id'] });
      where.userId = { [Op.in]: companyUsers.map(u => u.id) };
    }

    const leaves = await Leave.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'approver', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(leaves);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createLeave = async (req, res) => {
  try {
    const { type, startDate, endDate, reason } = req.body;
    const leaveType = String(type || '').trim().toLowerCase();
    const applicant = await User.findByPk(req.user.id, { attributes: ['id', 'gender'] });
    if (!applicant) return res.status(404).json({ message: 'User not found' });
    if (!VALID_LEAVE_TYPES.includes(leaveType)) {
      return res.status(400).json({ message: 'Invalid leave type selected' });
    }
    if (leaveType === 'maternity' && applicant.gender !== 'female') {
      return res.status(400).json({ message: 'Maternity leave is only available for female employees' });
    }
    if (leaveType === 'paternity' && applicant.gender !== 'male') {
      return res.status(400).json({ message: 'Paternity leave is only available for male employees' });
    }
    if (leaveType === 'other' && !String(reason || '').trim()) {
      return res.status(400).json({ message: 'Reason is required for Other leave' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ message: 'Please select valid leave dates' });
    }

    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (start < today) {
      return res.status(400).json({ message: 'Start date cannot be in the past' });
    }
    if (end < start) {
      return res.status(400).json({ message: 'End date must be on or after start date' });
    }

    const overlappingLeave = await Leave.findOne({
      where: {
        userId: req.user.id,
        status: { [Op.in]: ['pending', 'approved'] },
        startDate: { [Op.lte]: end },
        endDate: { [Op.gte]: start },
      },
    });
    if (overlappingLeave) {
      return res.status(400).json({ message: 'You already have a leave request for one or more of those dates' });
    }

    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    if (days <= 0) {
      return res.status(400).json({ message: 'Leave duration must be at least 1 day' });
    }

    const leave = await Leave.create({
      userId: req.user.id,
      companyId: req.user.companyId,
      type: leaveType, startDate: start, endDate: end, days, reason, status: 'pending',
    });
    res.status(201).json(leave);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.actionLeave = async (req, res) => {
  try {
    const { action, rejectionReason } = req.body;
    const leave = await Leave.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'role', 'managerId'] }],
    });
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    if (leave.status !== 'pending') return res.status(400).json({ message: 'Leave already processed' });

    const actor = req.user;
    const submitter = leave.user;

    // Nobody can approve their own leave
    if (submitter.id === actor.id) {
      return res.status(403).json({ message: 'Cannot approve your own leave' });
    }

    // Manager can only approve their direct reports (employees, not other managers)
    if (actor.role === 'manager') {
      if (submitter.role === 'manager') {
        return res.status(403).json({ message: 'Cannot approve another manager\'s leave. Needs admin or superadmin approval.' });
      }
      if (submitter.managerId !== actor.id) {
        return res.status(403).json({ message: 'Not your team member' });
      }
    }

    // Admin can approve anyone in their company (including managers)
    // Superadmin can approve anyone — no restrictions

    leave.status = action === 'approve' ? 'approved' : 'rejected';
    leave.approvedBy = actor.id;
    leave.approvedAt = new Date();
    if (rejectionReason) leave.rejectionReason = rejectionReason;
    await leave.save();

    const updated = await Leave.findByPk(leave.id, {
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

exports.deleteLeave = async (req, res) => {
  try {
    const leave = await Leave.findByPk(req.params.id, { include: [{ model: User, as: 'user', attributes: ['id','name'] }] });
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    if (leave.userId !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (leave.status !== 'pending') return res.status(400).json({ message: 'Cannot delete processed leave' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('leave', leave.id, req.user, leave.toJSON(), (leave.user?.name||'') + ' - ' + leave.type + ' leave');
    await leave.destroy();
    res.json({ message: 'Leave deleted (moved to recycle bin)' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
