const { Op } = require('sequelize');
const { Leave, User } = require('../models');

const VALID_LEAVE_TYPES = ['earned', 'casual', 'sick', 'maternity', 'paternity', 'unpaid', 'other', 'holiday', 'festival', 'company_event'];
const COMPANY_LEAVE_TYPES = ['holiday', 'festival', 'company_event'];

exports.getLeaves = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    let where = {};

    const companyHolidayClause = { type: { [Op.in]: COMPANY_LEAVE_TYPES }, companyId };

    if (role === 'employee') {
      where[Op.or] = [{ userId: id }, companyHolidayClause];
    } else if (role === 'manager') {
      if (req.query.scope === 'own') {
        where[Op.or] = [{ userId: id }, companyHolidayClause];
      } else if (req.query.scope === 'team') {
        const teamMembers = await User.findAll({ where: { managerId: id }, attributes: ['id'] });
        where[Op.or] = [{ userId: { [Op.in]: teamMembers.map(m => m.id) } }, companyHolidayClause];
      } else {
        const teamMembers = await User.findAll({ where: { managerId: id }, attributes: ['id'] });
        where[Op.or] = [{ userId: { [Op.in]: [...teamMembers.map(m => m.id), id] } }, companyHolidayClause];
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

    const start = String(startDate || '').slice(0, 10);
    const end   = String(endDate   || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ message: 'Please select valid leave dates' });
    }
    const isCompanyLeave = COMPANY_LEAVE_TYPES.includes(leaveType);

    if (!isCompanyLeave) {
      // Allow from the Monday of the previous week
      const now = new Date();
      const dow = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
      const daysToThisMon = dow === 0 ? 6 : dow - 1;
      const prevWeekMon = new Date(now);
      prevWeekMon.setDate(now.getDate() - daysToThisMon - 7);
      const minAllowed = prevWeekMon.toISOString().slice(0, 10);
      if (start < minAllowed) {
        return res.status(400).json({ message: 'Leave cannot be applied more than one week in the past' });
      }
    }
    if (end < start) {
      return res.status(400).json({ message: 'End date must be on or after start date' });
    }

    if (!isCompanyLeave) {
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
    }

    const days = Math.round((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
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

    // Nobody can approve their own leave (except company-wide holidays added by admin)
    if (submitter.id === actor.id && !COMPANY_LEAVE_TYPES.includes(leave.type)) {
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
