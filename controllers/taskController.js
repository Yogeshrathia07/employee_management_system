const { Task, User } = require('../models');

const include = [
  { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'employeeCode', 'position', 'department'] },
  { model: User, as: 'assigner', attributes: ['id', 'name'] },
];

const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);

// Who may change a task: superadmin any; admin within their company; a manager the
// tasks they assigned or that were assigned to them; an employee their own tasks.
function canManageTask(actor, task) {
  if (actor.role === 'superadmin') return true;
  if (actor.role === 'admin') return !!actor.companyId && sameId(task.companyId, actor.companyId);
  if (actor.role === 'manager') return sameId(task.assignedBy, actor.id) || sameId(task.assignedTo, actor.id);
  return sameId(task.assignedTo, actor.id);
}

// Returns an error message when the actor may not assign work to this user.
async function assigneeError(actor, assignedTo) {
  const assignee = await User.findByPk(assignedTo, { attributes: ['id', 'role', 'companyId', 'managerId'] });
  if (!assignee) return { status: 404, message: 'Assignee not found' };
  if (actor.role === 'manager' && !sameId(assignee.managerId, actor.id)) {
    return { status: 403, message: 'You can only assign tasks to your team members' };
  }
  if (actor.role === 'admin' && (!sameId(assignee.companyId, actor.companyId) || !['employee', 'manager'].includes(assignee.role))) {
    return { status: 403, message: 'You can only assign tasks to employees and managers of your company' };
  }
  return { assignee };
}

// ── GET /tasks ────────────────────────────────────────────────────────────────
exports.getTasks = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    let where = {};
    if (role === 'employee') {
      where.assignedTo = id;
    } else if (role === 'manager') {
      if (req.query.scope === 'assigned_to_me') {
        // tasks assigned TO this manager by admin/superadmin
        where.assignedTo = id;
      } else if (req.query.scope === 'assigned_by_me') {
        // tasks this manager assigned to employees
        where.assignedBy = id;
        if (req.query.assignedTo) where.assignedTo = req.query.assignedTo;
      } else {
        // default: all tasks involving this manager
        const { Op } = require('sequelize');
        where[Op.or] = [{ assignedBy: id }, { assignedTo: id }];
        if (req.query.assignedTo) where = { assignedTo: req.query.assignedTo, assignedBy: id };
      }
    } else {
      // An admin is always limited to their own company; a superadmin may filter by ?companyId.
      const filterCompany = role === 'superadmin' ? (req.query.companyId || companyId) : (companyId || -1);
      if (filterCompany) where.companyId = filterCompany;
      if (req.query.assignedTo) where.assignedTo = req.query.assignedTo;
      if (req.query.assignedBy) where.assignedBy = req.query.assignedBy;
    }
    if (req.query.status) where.status = req.query.status;
    const tasks = await Task.findAll({ where, include, order: [['dueDate', 'ASC'], ['createdAt', 'DESC']] });
    res.json(tasks);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /tasks ───────────────────────────────────────────────────────────────
exports.createTask = async (req, res) => {
  try {
    const { title, description, assignedTo, dueDate, priority, projectName } = req.body;
    if (!title || !assignedTo) return res.status(400).json({ message: 'Title and assignedTo are required' });
    const checked = await assigneeError(req.user, assignedTo);
    if (checked.message) return res.status(checked.status).json({ message: checked.message });
    const task = await Task.create({
      title, description: description || '', projectName: projectName || '',
      assignedTo, assignedBy: req.user.id,
      companyId: checked.assignee.companyId || req.user.companyId,
      dueDate: dueDate || null,
      priority: priority || 'medium',
      status: 'todo', approvalStatus: 'none',
    });
    const populated = await Task.findByPk(task.id, { include });
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /tasks/:id ────────────────────────────────────────────────────────────
exports.updateTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (!canManageTask(req.user, task) || (req.user.role === 'manager' && !sameId(task.assignedBy, req.user.id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const { title, description, assignedTo, dueDate, priority, projectName } = req.body;
    if (assignedTo && !sameId(assignedTo, task.assignedTo)) {
      const checked = await assigneeError(req.user, assignedTo);
      if (checked.message) return res.status(checked.status).json({ message: checked.message });
    }
    if (title)                     task.title       = title;
    if (projectName !== undefined) task.projectName = projectName;
    if (description !== undefined) task.description = description;
    if (assignedTo)                task.assignedTo  = assignedTo;
    if (dueDate !== undefined)     task.dueDate     = dueDate || null;
    if (priority)                  task.priority    = priority;
    await task.save();
    const populated = await Task.findByPk(task.id, { include });
    res.json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /tasks/:id/status — employee starts task ────────────────────────────
exports.updateTaskStatus = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (!canManageTask(req.user, task)) return res.status(403).json({ message: 'Access denied' });
    const { status } = req.body;
    if (!['todo', 'in_progress', 'done'].includes(status))
      return res.status(400).json({ message: 'Invalid status' });
    // Only allow employee to set in_progress (start). done requires approval.
    if (req.user.role === 'employee' && status === 'done')
      return res.status(400).json({ message: 'Use the completion request endpoint to mark done' });
    task.status      = status;
    task.completedAt = status === 'done' ? new Date() : null;
    await task.save();
    res.json(task);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /tasks/:id/request-completion — employee requests completion approval
exports.requestCompletion = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (task.assignedTo !== req.user.id)
      return res.status(403).json({ message: 'Access denied' });
    task.approvalStatus = 'pending_approval';
    task.status         = 'in_progress'; // still in progress until manager approves
    await task.save();
    res.json(task);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /tasks/:id/approve-completion — manager approves completion ─────────
exports.approveCompletion = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    // A manager approves only work they assigned; an admin only within their company.
    if (req.user.role === 'manager' && !sameId(task.assignedBy, req.user.id))
      return res.status(403).json({ message: 'Access denied' });
    if (!canManageTask(req.user, task)) return res.status(403).json({ message: 'Access denied' });
    task.approvalStatus = 'approved';
    task.status         = 'done';
    task.completedAt    = new Date();
    await task.save();
    const populated = await Task.findByPk(task.id, { include });
    res.json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /tasks/:id/refuse — employee refuses the task ──────────────────────
exports.refuseTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (task.assignedTo !== req.user.id)
      return res.status(403).json({ message: 'Access denied' });
    const { reason } = req.body;
    if (!reason || !reason.trim())
      return res.status(400).json({ message: 'A reason is required to refuse a task' });
    task.approvalStatus = 'refused';
    task.refusalReason  = reason.trim();
    task.refusedAt      = new Date();
    await task.save();
    res.json(task);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /tasks/:id ─────────────────────────────────────────────────────────
exports.deleteTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    if (!canManageTask(req.user, task) || (req.user.role === 'manager' && !sameId(task.assignedBy, req.user.id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    await task.destroy();
    res.json({ message: 'Task deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
