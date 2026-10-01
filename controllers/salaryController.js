const { Op } = require('sequelize');
const { Salary, Timesheet, Leave, User, Company } = require('../models');
const PayrollCalc = require('../public/js/payroll-calc');
const { useUnicodeFonts } = require('./pdfHelper');

async function resolveActorCompanyId(req) {
  if (req.user.companyId) return req.user.companyId;
  if (req.user.company && req.user.company.id) return req.user.company.id;
  const actor = await User.findByPk(req.user.id, { attributes: ['id', 'companyId'] });
  return actor?.companyId || null;
}

function monthKey(month, year) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

// Days in the pay period: requested value (1..calendar days) or the calendar month.
function resolveTotalDays(requested, month, year) {
  const calDays = PayrollCalc.daysInMonth(month, year);
  const n = parseOptionalNumber(requested);
  return n && n > 0 ? Math.min(calDays, n) : calDays;
}

// ─── Helper: hours and distinct days logged in approved timesheets ───────────
async function getActualHours(userId, month, year) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0, 23, 59, 59);
  const prefix     = monthKey(month, year);

  const timesheets = await Timesheet.findAll({
    where: {
      userId,
      status: 'approved',
      weekStart: { [Op.lte]: monthEnd },
      weekEnd:   { [Op.gte]: monthStart },
    },
  });

  let totalHours = 0;
  const days = new Set();
  timesheets.forEach(ts => {
    (ts.entries || []).forEach(e => {
      const date = String(e.date || '').slice(0, 10);
      if (date.slice(0, 7) !== prefix) return;
      const hours = Number(e.hours) || 0;
      if (hours <= 0) return;
      totalHours += hours;
      days.add(date);
    });
  });
  return { totalHours, loggedDays: days.size };
}

// ─── Helper: project / work hours from approved timesheets (payslip summary) ─
function workLabel(entry) {
  const project = String(entry.project || '').trim();
  const workItem = String(entry.workItem || '').trim();
  if (entry.projectId && project) return workItem ? `${project} · ${workItem}` : project;
  if (workItem) return `General Work · ${workItem}`;
  return project || 'General Work';
}

async function getWorkSummary(userId, month, year) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0, 23, 59, 59);
  const prefix     = monthKey(month, year);
  const timesheets = await Timesheet.findAll({
    where: {
      userId,
      status: 'approved',
      weekStart: { [Op.lte]: monthEnd },
      weekEnd:   { [Op.gte]: monthStart },
    },
  });

  const groups = new Map();
  const allDays = new Set();
  let totalHours = 0;
  timesheets.forEach(ts => {
    (ts.entries || []).forEach(e => {
      const date = String(e.date || '').slice(0, 10);
      if (date.slice(0, 7) !== prefix) return;
      const hours = Number(e.hours) || 0;
      if (hours <= 0) return;
      const label = workLabel(e);
      if (!groups.has(label)) {
        groups.set(label, { label, projectId: e.projectId || null, workItemId: e.workItemId || null, hours: 0, billableHours: 0, days: new Set() });
      }
      const g = groups.get(label);
      g.hours += hours;
      if (String(e.billingType || 'Billable') === 'Billable') g.billableHours += hours;
      g.days.add(date);
      allDays.add(date);
      totalHours += hours;
    });
  });

  const rows = Array.from(groups.values())
    .map(g => ({ label: g.label, projectId: g.projectId, workItemId: g.workItemId, hours: g.hours, billableHours: g.billableHours, days: g.days.size }))
    .sort((a, b) => b.hours - a.hours);
  return { rows, totalHours, totalDays: allDays.size };
}

// ─── Helper: approved leave days in month ────────────────────────────────────
function numberToWords(n) {
  const num = Math.round(Math.abs(Number(n || 0)));
  if (num === 0) return 'Rupees Zero Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

  function convert(x) {
    if (x === 0) return '';
    if (x < 20) return ones[x] + ' ';
    if (x < 100) return tens[Math.floor(x / 10)] + (ones[x % 10] ? ' ' + ones[x % 10] : '') + ' ';
    if (x < 1000) return ones[Math.floor(x / 100)] + ' Hundred ' + convert(x % 100);
    if (x < 100000) return convert(Math.floor(x / 1000)) + 'Thousand ' + convert(x % 1000);
    if (x < 10000000) return convert(Math.floor(x / 100000)) + 'Lakh ' + convert(x % 100000);
    return convert(Math.floor(x / 10000000)) + 'Crore ' + convert(x % 10000000);
  }

  return 'Rupees ' + convert(num).trim().replace(/\s+/g, ' ') + ' Only';
}

async function getLeaveTaken(userId, month, year) {
  const { totalLeaveDays } = await getLeaveBreakdown(userId, month, year);
  return totalLeaveDays;
}

// ─── Helper: detailed leave breakdown for month ───────────────────────────────
async function getLeaveBreakdown(userId, month, year) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0, 23, 59, 59);

  const leaves = await Leave.findAll({
    where: {
      userId,
      status: 'approved',
      startDate: { [Op.lte]: monthEnd },
      endDate:   { [Op.gte]: monthStart },
    },
  });

  const HOLIDAY_TYPES = ['holiday', 'festival', 'company_event'];
  const breakdown = {};
  let totalLeaveDays = 0;
  let holidayDays = 0;

  leaves.forEach(l => {
    const start = new Date(Math.max(new Date(l.startDate), monthStart));
    const end   = new Date(Math.min(new Date(l.endDate),   monthEnd));
    const days  = Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
    if (!days) return;

    const type = l.type || 'other';
    breakdown[type] = (breakdown[type] || 0) + days;

    if (HOLIDAY_TYPES.includes(type)) {
      holidayDays += days;
    } else {
      totalLeaveDays += days;
    }
  });

  return { breakdown, totalLeaveDays, holidayDays };
}

// Admins only touch payroll of their own company.
function canAccessSalary(req, salary) {
  const actor = req.user;
  if (actor.role === 'superadmin') return true;
  if (actor.role === 'admin') {
    const companyId = Number(actor.companyId || 0);
    return !!companyId && (Number(salary.companyId || 0) === companyId || Number(salary.user?.companyId || 0) === companyId);
  }
  return Number(salary.userId) === Number(actor.id);
}

// ─── GET /salary/preview — fetch defaults before generation ──────────────────
exports.getSalaryPreview = async (req, res) => {
  try {
    const { userId, month, year } = req.query;
    if (!userId || !month || !year) {
      return res.status(400).json({ message: 'userId, month, year are required' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'Employee not found' });

    const [{ totalHours, loggedDays }, leaveBreakdown] = await Promise.all([
      getActualHours(Number(userId), Number(month), Number(year)),
      getLeaveBreakdown(Number(userId), Number(month), Number(year)),
    ]);

    const totalDays     = resolveTotalDays(req.query.totalDays, Number(month), Number(year));
    const allowedLeave  = user.allowedLeavePerMonth != null ? user.allowedLeavePerMonth : 2;
    const pfContribution = user.pfApplicable ? PayrollCalc.defaultPf(user.basicSalary, user.da) : 0;
    const calc = PayrollCalc.compute({
      totalDays,
      allowedLeave,
      leaveTaken: leaveBreakdown.totalLeaveDays,
      basicSalary: user.basicSalary, da: user.da, hra: user.hra, conveyance: user.conveyance,
      medicalExpenses: user.medicalExpenses, specialAllowance: user.specialAllowance,
      bonus: user.bonus, ta: user.ta, pfContribution,
    });

    res.json({
      // Attendance summary
      leaveTaken:   leaveBreakdown.totalLeaveDays,
      actualHours:  totalHours,
      loggedDays,
      totalDays,
      calDays:      PayrollCalc.daysInMonth(Number(month), Number(year)),
      holidayDays:  leaveBreakdown.holidayDays,
      leaveBreakdown: leaveBreakdown.breakdown,
      // Salary structure from profile
      baseSalary:       calc.ctc,
      basicSalary:      user.basicSalary       || 0,
      da:               user.da                || 0,
      hra:              user.hra               || 0,
      conveyance:       user.conveyance        || 0,
      medicalExpenses:  user.medicalExpenses   || 0,
      specialAllowance: user.specialAllowance  || 0,
      bonus:            user.bonus             || 0,
      ta:               user.ta                || 0,
      allowedLeave,
      pfContribution,
      payroll: calc,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /salary ─────────────────────────────────────────────────────────────
exports.getSalaries = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    let where = {};

    if (role === 'employee' || role === 'manager') {
      where.userId = id;
    } else if (role === 'admin') {
      const companyUsers = await User.findAll({ where: { companyId }, attributes: ['id'] });
      where.userId = { [Op.in]: companyUsers.map(u => u.id) };
    }
    if (req.user.role === 'superadmin' && req.query.companyId) {
      where.companyId = req.query.companyId;
    }

    if (req.query.month) where.month = Number(req.query.month);
    if (req.query.year)  where.year  = Number(req.query.year);

    const salaries = await Salary.findAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department', 'position', 'employeeCode', 'gender', 'pfApplicable', 'companyId'] }],
      order: [['year', 'DESC'], ['month', 'DESC']],
    });
    res.json(salaries.map(s => Salary.withPayroll(s)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Build the stored inputs for a new salary record from the request + profile.
function buildSalaryInputs(body, user, month, year, leaveTakenAuto) {
  const given = (field) => body[field] !== undefined && body[field] !== null && body[field] !== '';
  const p = (field) => given(field) ? parseFloat(body[field]) || 0 : (user[field] || 0);
  const bodyNum = (field) => given(field) ? parseFloat(body[field]) || 0 : 0;

  // Older payroll sheets sent their "Worked Days" as totalWorkDays.
  const legacyWorked = body.totalDays === undefined && body.workedDays === undefined && body.totalWorkDays !== undefined;
  const basicSalary = p('basicSalary');
  const da = p('da');

  return {
    totalDays:    resolveTotalDays(legacyWorked ? null : body.totalDays, month, year),
    workedDays:   parseOptionalNumber(legacyWorked ? body.totalWorkDays : body.workedDays),
    leaveTaken:   given('leaveTaken') ? parseFloat(body.leaveTaken) || 0 : leaveTakenAuto,
    allowedLeave: given('allowedLeave')
      ? parseFloat(body.allowedLeave) || 0
      : (user.allowedLeavePerMonth != null ? user.allowedLeavePerMonth : 2),
    // Earnings
    basicSalary,
    da,
    hra:              p('hra'),
    conveyance:       p('conveyance'),
    medicalExpenses:  p('medicalExpenses'),
    specialAllowance: p('specialAllowance'),
    bonus:            p('bonus'),
    ta:               p('ta'),
    // Deductions
    pfContribution:  given('pfContribution')
      ? parseFloat(body.pfContribution) || 0
      : (user.pfApplicable ? PayrollCalc.defaultPf(basicSalary, da) : 0),
    professionTax:   bodyNum('professionTax'),
    tds:             bodyNum('tds'),
    salaryAdvance:   bodyNum('salaryAdvance'),
    applyAbsentDeduction: body.applyAbsentDeduction !== undefined ? !!body.applyAbsentDeduction : true,
    manualDeductionAmount: bodyNum('manualDeductionAmount'),
  };
}

// ─── POST /salary — single employee ──────────────────────────────────────────
exports.createSalary = async (req, res) => {
  try {
    const { userId, month, year, companyId: requestedCompanyId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Employee is required' });
    if (!month || month < 1 || month > 12) return res.status(400).json({ message: 'Valid month (1-12) is required' });
    if (!year || year < 2000 || year > 2100) return res.status(400).json({ message: 'Valid year is required' });

    const exists = await Salary.findOne({ where: { userId, month, year } });
    if (exists) return res.status(400).json({ message: 'Salary record already exists for this month/year' });

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'Employee not found' });

    const actorCompanyId = await resolveActorCompanyId(req);
    const requestedCompany = Number(requestedCompanyId || 0) || null;
    let targetCompanyId = actorCompanyId || user.companyId || null;
    if (req.user.role === 'superadmin') {
      targetCompanyId = Number(requestedCompanyId || user.companyId || 0) || null;
      if (!targetCompanyId) return res.status(400).json({ message: 'Select a company first' });
    } else if (!targetCompanyId && requestedCompany) {
      targetCompanyId = requestedCompany;
    }
    if (req.user.role !== 'superadmin' && actorCompanyId && user.companyId !== actorCompanyId) {
      return res.status(403).json({ message: 'You can only generate payroll for your own company' });
    }

    const { totalHours } = await getActualHours(userId, Number(month), Number(year));
    const leaveTakenAuto = await getLeaveTaken(userId, Number(month), Number(year));
    const inputs = buildSalaryInputs(req.body, user, Number(month), Number(year), leaveTakenAuto);
    const expectedHours = req.body.expectedHours !== undefined
      ? parseFloat(req.body.expectedHours) || 0
      : Math.round(inputs.totalDays) * 8;

    const salary = await Salary.create(Object.assign({
      userId,
      companyId: targetCompanyId,
      month: Number(month),
      year:  Number(year),
      expectedHours,
      actualHours: totalHours,
      notes:       req.body.notes || '',
      generatedBy: req.user.id,
    }, inputs));

    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'position', 'employeeCode'] }],
    });
    res.status(201).json(Salary.withPayroll(populated));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /salary/generate-bulk ───────────────────────────────────────────────
exports.generateBulk = async (req, res) => {
  try {
    const { month, year, companyId: requestedCompanyId } = req.body;
    if (!month || !year) return res.status(400).json({ message: 'Month and year are required' });
    if (month < 1 || month > 12) return res.status(400).json({ message: 'Valid month (1-12) is required' });
    if (year < 2000 || year > 2100) return res.status(400).json({ message: 'Valid year is required' });

    const actorCompanyId = await resolveActorCompanyId(req);
    const requestedCompany = Number(requestedCompanyId || 0) || null;
    const companyId = req.user.role === 'superadmin'
      ? Number(requestedCompanyId || 0)
      : (actorCompanyId || requestedCompany);
    if (!companyId) return res.status(400).json({ message: 'Select a company before generating payroll' });

    const users = await User.findAll({
      where: { companyId, status: 'active', role: { [Op.in]: ['employee', 'manager'] } },
    });

    let created = 0, skipped = 0;

    for (const user of users) {
      const exists = await Salary.findOne({ where: { userId: user.id, month: Number(month), year: Number(year) } });
      if (exists) { skipped++; continue; }

      const { totalHours } = await getActualHours(user.id, Number(month), Number(year));
      const leaveTakenAuto = await getLeaveTaken(user.id, Number(month), Number(year));
      const inputs = buildSalaryInputs({ totalDays: req.body.totalDays }, user, Number(month), Number(year), leaveTakenAuto);

      await Salary.create(Object.assign({
        userId:    user.id,
        companyId,
        month:     Number(month),
        year:      Number(year),
        expectedHours: Math.round(inputs.totalDays) * 8,
        actualHours:   totalHours,
        generatedBy: req.user.id,
      }, inputs));
      created++;
    }

    res.json({ message: `Generated ${created} salary records, ${skipped} already existed`, created, skipped });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── PUT /salary/:id ──────────────────────────────────────────────────────────
exports.updateSalary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'companyId'] }],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (!canAccessSalary(req, salary)) return res.status(403).json({ message: 'Access denied' });
    if (salary.status === 'paid') return res.status(400).json({ message: 'Cannot edit paid salary' });

    const editableFields = [
      'leaveTaken', 'allowedLeave',
      'basicSalary', 'da', 'hra', 'conveyance', 'medicalExpenses', 'specialAllowance', 'bonus', 'ta',
      'pfContribution', 'professionTax', 'tds', 'salaryAdvance',
      'expectedHours', 'notes', 'status', 'applyAbsentDeduction',
      'manualDeductionAmount',
    ];
    editableFields.forEach(f => { if (req.body[f] !== undefined) salary[f] = req.body[f]; });

    if (req.body.totalDays !== undefined) {
      salary.totalDays = resolveTotalDays(req.body.totalDays, salary.month, salary.year);
    }
    if (req.body.workedDays !== undefined) {
      salary.workedDays = parseOptionalNumber(req.body.workedDays);
    } else if (req.body.totalDays === undefined && req.body.totalWorkDays !== undefined) {
      // Older payroll sheets sent their "Worked Days" as totalWorkDays.
      salary.totalDays = PayrollCalc.daysInMonth(salary.month, salary.year);
      salary.workedDays = parseOptionalNumber(req.body.totalWorkDays);
    }

    if (req.body.status === 'finalized' && salary.changed('status')) {
      salary.finalizedBy = req.user.id;
      salary.finalizedAt = new Date();
    }

    await salary.save(); // the model hook recalculates every derived figure

    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'position', 'employeeCode'] }],
    });
    res.json(Salary.withPayroll(populated));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── PATCH /salary/:id/pay ────────────────────────────────────────────────────
exports.paySalary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'companyId'] }],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (!canAccessSalary(req, salary)) return res.status(403).json({ message: 'Access denied' });
    if (salary.status !== 'finalized') return res.status(400).json({ message: 'Salary must be finalized before paying' });
    salary.status = 'paid';
    salary.paidAt = new Date();
    await salary.save();
    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
    });
    res.json(Salary.withPayroll(populated));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── DELETE /salary/:id ───────────────────────────────────────────────────────
exports.deleteSalary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'companyId'] }],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (!canAccessSalary(req, salary)) return res.status(403).json({ message: 'Access denied' });
    if (salary.status === 'paid') return res.status(400).json({ message: 'Cannot delete paid salary' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('salary', salary.id, req.user, salary.toJSON(), 'Salary #' + salary.id);
    await salary.destroy();
    res.json({ message: 'Salary deleted (moved to recycle bin)' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /salary/export/csv ───────────────────────────────────────────────────
exports.exportCSV = async (req, res) => {
  try {
    const { month, year } = req.query;
    const where = {};
    if (req.user.role === 'admin') where.companyId = req.user.companyId;
    if (month) where.month = Number(month);
    if (year)  where.year  = Number(year);

    const salaries = await Salary.findAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department'] }],
      order: [['year', 'DESC'], ['month', 'DESC']],
    });

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const header = [
      'Employee', 'Email', 'Department', 'Role', 'Period', 'CTC',
      'Total Days', 'Allowed Leave', 'Leave Taken', 'LOP Days', 'Worked Days',
      'Basic Salary', 'DA', 'HRA', 'Conveyance (Working)', 'Medical', 'Special', 'Bonus', 'TA', 'Gross Salary',
      'PF', 'Profession Tax', 'TDS', 'Salary Advance', 'Absent/LOP Deduction', 'Total Deductions', 'Net Salary',
      'Status', 'Paid On',
    ];
    const quote = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    let csv = header.join(',') + '\n';

    salaries.forEach(row => {
      const s = Salary.withPayroll(row);
      const p = s.payroll;
      csv += [
        quote(s.user?.name || ''),
        quote(s.user?.email || ''),
        quote(s.user?.department || ''),
        quote(s.user?.role || ''),
        quote(`${MONTHS[s.month - 1]} ${s.year}`),
        p.ctc,
        p.totalDays, p.allowedLeave, p.leaveTaken, p.lopDays, p.workedDays,
        p.basicSalary, p.da, p.hra, p.conveyanceWorking, p.medicalWorking, p.specialAllowance, p.bonus, p.ta, p.grossSalary,
        p.pfContribution, p.professionTax, p.tds, p.salaryAdvance, p.absentDeduction, p.totalDeductions, p.netSalary,
        quote(s.status),
        quote(s.paidAt ? new Date(s.paidAt).toLocaleDateString('en-IN') : ''),
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=salaries_${month || 'all'}_${year || 'all'}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /salary/:id/work-summary — project / work hours for the payslip ─────
exports.getSalaryWorkSummary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'companyId'] }],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (!canAccessSalary(req, salary)) return res.status(403).json({ message: 'Access denied' });
    res.json(await getWorkSummary(salary.userId, salary.month, salary.year));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /salary/:id/payslip ──────────────────────────────────────────────────
exports.generatePayslip = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department', 'position', 'jobTitle', 'phone', 'employeeCode', 'workLocation', 'joiningDate', 'companyId'] },
        { model: Company, as: 'company' },
      ],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (!canAccessSalary(req, salary)) return res.status(403).json({ message: 'Access denied' });
    if ((req.user.role === 'employee' || req.user.role === 'manager') && !['finalized', 'paid'].includes(String(salary.status || '').toLowerCase())) {
      return res.status(403).json({ message: 'Your payslip will be available once payroll for this month is frozen' });
    }

    let company = salary.company;
    if (!company && salary.user?.companyId) company = await Company.findByPk(salary.user.companyId);
    company = company || {};
    const data = Salary.withPayroll(salary);
    const p = data.payroll;
    const work = await getWorkSummary(salary.userId, salary.month, salary.year);

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));

    const fonts = useUnicodeFonts(doc);
    const fontRegular = fonts.regular;
    const fontBold = fonts.bold;
    const cur = (n) => (fonts.rupee ? '₹ ' : 'Rs. ') + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const days = (n) => {
      const v = Number(n || 0);
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
    };

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const user = salary.user || {};
    const pageW = 595.28;
    const mL = 50;
    const cW = pageW - 100;
    const pageR = pageW - 50;
    const monthLabel = `${MONTHS[salary.month - 1]} ${salary.year}`;
    const employeeCode = user.employeeCode || `EMP-${String(user.id || salary.userId || 0).padStart(4, '0')}`;
    const designation = user.position || user.jobTitle || (user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '');
    const joiningDate = user.joiningDate
      ? new Date(user.joiningDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    const generatedOn = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    const black = '#111111';
    const muted = '#666666';
    const red = '#c1121f';
    const border = '#d9d9d9';
    const white = '#ffffff';

    function rowText(y, leftLabel, leftValue, rightLabel, rightValue) {
      doc.font(fontRegular).fontSize(8).fillColor(muted).text(leftLabel, mL + 8, y);
      doc.font(fontBold).fontSize(9).fillColor(black).text(String(leftValue || '-'), mL + 98, y, { width: 180, lineBreak: false, ellipsis: true });
      doc.font(fontRegular).fontSize(8).fillColor(muted).text(rightLabel, 318, y);
      doc.font(fontBold).fontSize(9).fillColor(black).text(String(rightValue || '-'), 405, y, { width: 135, lineBreak: false, ellipsis: true });
    }

    function statText(x, y, label, value) {
      doc.font(fontBold).fontSize(7.5).fillColor(black).text(label.toUpperCase(), x, y, { width: 95 });
      doc.font(fontBold).fontSize(15).fillColor(black).text(String(value), x, y + 13, { width: 95 });
    }

    const ROW_H = 20;
    function drawSplitRow(y, leftLabel, leftValue, rightLabel, rightValue) {
      const half = cW / 2;
      doc.strokeColor(border).lineWidth(1).moveTo(mL, y + ROW_H).lineTo(pageR, y + ROW_H).stroke();
      doc.strokeColor(border).lineWidth(1).moveTo(mL + half, y).lineTo(mL + half, y + ROW_H).stroke();
      doc.font(fontRegular).fontSize(8).fillColor(black).text(leftLabel, mL + 12, y + 6, { width: half - 110 });
      doc.font(fontBold).fontSize(8).fillColor(black).text(cur(leftValue), mL + half - 106, y + 6, { width: 94, align: 'right' });
      if (rightLabel) {
        doc.font(fontRegular).fontSize(8).fillColor(black).text(rightLabel, mL + half + 12, y + 6, { width: half - 110 });
        doc.font(fontBold).fontSize(8).fillColor(black).text(cur(rightValue), pageR - 94, y + 6, { width: 82, align: 'right' });
      }
    }

    doc.rect(mL, 40, cW, 752).fillColor(white).strokeColor(border).lineWidth(1).fillAndStroke();

    doc.font(fontBold).fontSize(22).fillColor(black)
      .text(company.name || 'Company', mL, 56, { width: cW, align: 'center' });
    doc.font(fontRegular).fontSize(9).fillColor(muted)
      .text(company.address || '', mL + 24, 84, { width: cW - 48, align: 'center', lineBreak: false, ellipsis: true })
      .text([company.phone, company.email].filter(Boolean).join(' | '), mL + 24, 97, { width: cW - 48, align: 'center' });
    doc.font(fontBold).fontSize(16).fillColor(black)
      .text('SALARY SLIP', mL, 118, { width: cW, align: 'center' });
    doc.font(fontRegular).fontSize(10).fillColor(red)
      .text(`For the month of ${monthLabel}`, mL, 138, { width: cW, align: 'center' });

    rowText(164, 'Employee Name:', user.name, 'Employee ID:', employeeCode);
    rowText(179, 'Department:', user.department, 'Designation:', designation);
    rowText(194, 'Work Location:', user.workLocation, 'Joining Date:', joiningDate);
    rowText(209, 'Email:', user.email, 'Phone:', user.phone);
    rowText(224, 'Pay Period:', monthLabel, 'Monthly CTC:', cur(p.ctc));

    doc.moveTo(mL, 244).lineTo(pageR, 244).strokeColor(border).lineWidth(1).stroke();
    statText(mL + 12, 254, 'Total Days', days(p.totalDays));
    statText(mL + 108, 254, 'Leave Taken', days(p.leaveTaken));
    statText(mL + 204, 254, 'LOP Days', days(p.lopDays));
    statText(mL + 300, 254, 'Worked Days', days(p.workedDays));
    statText(mL + 396, 254, 'Present Days', days(p.presentDays));
    doc.moveTo(mL, 296).lineTo(pageR, 296).strokeColor(border).lineWidth(1).stroke();

    const half = cW / 2;
    doc.font(fontBold).fontSize(10).fillColor(black).text('Earnings', mL + 12, 306);
    doc.font(fontBold).fontSize(10).fillColor(red).text('Deductions', mL + half + 12, 306);
    doc.moveTo(mL, 322).lineTo(pageR, 322).strokeColor(border).lineWidth(1).stroke();

    const conveyanceLabel = p.conveyanceWorking !== p.conveyance ? `Conveyance (${days(p.workedDays)}/${days(p.totalDays)} days)` : 'Conveyance';
    const earnings = [
      ['Basic Salary', p.basicSalary],
      ['DA (Dearness Allow.)', p.da],
      ['HRA', p.hra],
      [conveyanceLabel, p.conveyanceWorking],
      ['Medical Allowance', p.medicalWorking],
      ['Special Allowance', p.specialAllowance],
      ['Bonus', p.bonus],
      ['Travel Allow. (TA)', p.ta],
    ];
    const absentLabel = p.absentDeductionIsManual
      ? 'Deduction (Admin set)'
      : `Absent / LOP (${days(p.unpaidDays)} day${p.unpaidDays === 1 ? '' : 's'})`;
    const deductions = [
      ['PF Contribution', p.pfContribution],
      ['Profession Tax', p.professionTax],
      ['TDS', p.tds],
      ['Salary Advance', p.salaryAdvance],
      [absentLabel, p.absentDeduction],
      ['', 0],
      ['', 0],
      ['', 0],
    ];

    let y = 322;
    for (let i = 0; i < earnings.length; i++) {
      drawSplitRow(y, earnings[i][0], earnings[i][1], deductions[i][0], deductions[i][1]);
      y += ROW_H;
    }

    doc.rect(mL, y, half, 24).fillColor(white).strokeColor(border).lineWidth(1).fillAndStroke();
    doc.rect(mL + half, y, half, 24).fillColor(white).strokeColor(border).lineWidth(1).fillAndStroke();
    doc.font(fontBold).fontSize(9).fillColor(black).text('Gross Salary', mL + 12, y + 8);
    doc.font(fontBold).fontSize(9).fillColor(black).text(cur(p.grossSalary), mL + half - 106, y + 8, { width: 94, align: 'right' });
    doc.font(fontBold).fontSize(9).fillColor(red).text('Total Deductions', mL + half + 12, y + 8);
    doc.font(fontBold).fontSize(9).fillColor(black).text(cur(p.totalDeductions), pageR - 94, y + 8, { width: 82, align: 'right' });
    y += 24;

    doc.rect(mL + 10, y + 12, cW - 20, 38).fillColor(black).fill();
    doc.font(fontBold).fontSize(14).fillColor(white).text('NET PAY', mL + 26, y + 24);
    doc.font(fontBold).fontSize(20).fillColor(white).text(cur(p.netSalary), pageR - 200, y + 20, { width: 172, align: 'right' });
    y += 56;

    doc.font(fontRegular).fontSize(8).fillColor(muted)
      .text(numberToWords(p.netSalary), mL + 10, y, { width: cW - 20 });
    doc.font(fontRegular).fontSize(7).fillColor(muted)
      .text(`Paid leave: ${days(p.paidLeave)} of ${days(p.allowedLeave)} allowed · LOP days: ${days(p.lopDays)} · Per-day rate for LOP: ${cur(p.perDayRate)} (CTC excl. conveyance ÷ ${days(p.totalDays)} days)`,
        mL + 10, y + 12, { width: cW - 20 });
    y += 30;

    // Project / work summary from approved timesheets
    const footerY = 724;
    if (work.rows.length) {
      const maxRows = Math.max(1, Math.floor((footerY - 12 - (y + 30)) / 12));
      let rows = work.rows.slice();
      if (rows.length > maxRows) {
        const kept = rows.slice(0, maxRows - 1);
        const rest = rows.slice(maxRows - 1);
        kept.push({
          label: `Other work (${rest.length} item${rest.length === 1 ? '' : 's'})`,
          hours: rest.reduce((s, r) => s + r.hours, 0),
          billableHours: rest.reduce((s, r) => s + r.billableHours, 0),
          days: rest.reduce((s, r) => s + r.days, 0),
        });
        rows = kept;
      }
      doc.font(fontBold).fontSize(9).fillColor(black)
        .text('Project / Work Summary (approved timesheets)', mL + 10, y);
      doc.font(fontRegular).fontSize(7.5).fillColor(muted)
        .text(`${work.totalHours.toFixed(1)} hrs on ${work.totalDays} day(s)`, pageR - 160, y + 1, { width: 150, align: 'right' });
      y += 14;
      doc.rect(mL + 10, y, cW - 20, 13).fillColor('#f3f4f6').fill();
      doc.font(fontBold).fontSize(7.5).fillColor(black)
        .text('Project / Work', mL + 16, y + 3)
        .text('Days', pageR - 190, y + 3, { width: 50, align: 'right' })
        .text('Billable Hrs', pageR - 135, y + 3, { width: 60, align: 'right' })
        .text('Hours', pageR - 70, y + 3, { width: 54, align: 'right' });
      y += 13;
      rows.forEach(r => {
        doc.font(fontRegular).fontSize(7.5).fillColor(black)
          .text(r.label, mL + 16, y + 2, { width: cW - 230, lineBreak: false, ellipsis: true })
          .text(String(r.days), pageR - 190, y + 2, { width: 50, align: 'right' })
          .text(r.billableHours.toFixed(1), pageR - 135, y + 2, { width: 60, align: 'right' })
          .text(r.hours.toFixed(1), pageR - 70, y + 2, { width: 54, align: 'right' });
        doc.moveTo(mL + 10, y + 12).lineTo(pageR - 10, y + 12).strokeColor('#eeeeee').lineWidth(0.6).stroke();
        y += 12;
      });
    }

    doc.moveTo(mL + 10, footerY).lineTo(pageR - 10, footerY).strokeColor(border).lineWidth(1).stroke();
    doc.font(fontRegular).fontSize(8).fillColor('#9ca3af')
      .text(`Generated on ${generatedOn}`, mL + 10, footerY + 10)
      .text('This is a computer-generated document.', mL + 10, footerY + 22);
    doc.font(fontRegular).fontSize(8).fillColor(muted)
      .text('Authorized by', pageR - 150, footerY + 10, { width: 120, align: 'center' });
    doc.font(fontBold).fontSize(10).fillColor(black)
      .text(company.authorizedSignatory || 'Admin', pageR - 150, footerY + 24, { width: 120, align: 'center' });

    if (salary.notes) {
      doc.font(fontRegular).fontSize(8).fillColor(muted)
        .text(`Note: ${salary.notes}`, mL + 10, 766, { width: cW - 20, height: 20, ellipsis: true });
    }

    const pdfBuffer = await new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    const mode = req.query.mode || 'download';
    const fname = `payslip_${String(user.name || 'employee').replace(/[^a-z0-9]+/gi, '_')}_${salary.month}_${salary.year}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `${mode === 'view' ? 'inline' : 'attachment'}; filename=${fname}`);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error('generatePayslip failed:', err);
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ message: err.message });
    }
  }
};
