const { Op } = require('sequelize');
const { Salary, Timesheet, Leave, User, Company } = require('../models');

async function resolveActorCompanyId(req) {
  if (req.user.companyId) return req.user.companyId;
  if (req.user.company && req.user.company.id) return req.user.company.id;
  const actor = await User.findByPk(req.user.id, { attributes: ['id', 'companyId'] });
  return actor?.companyId || null;
}

// ─── Helper: actual hours from approved timesheets ────────────────────────────
async function getActualHours(userId, month, year) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0, 23, 59, 59);

  const timesheets = await Timesheet.findAll({
    where: {
      userId,
      status: 'approved',
      weekStart: { [Op.lte]: monthEnd },
      weekEnd:   { [Op.gte]: monthStart },
    },
  });

  let totalHours = 0, presentDays = 0;
  timesheets.forEach(ts => {
    let entries = ts.entries || [];
    if (typeof entries === 'string') { try { entries = JSON.parse(entries); } catch(e) { entries = []; } }
    if (!Array.isArray(entries)) entries = [];
    entries.forEach(e => {
      const d = new Date(e.date);
      if (d >= monthStart && d <= monthEnd) {
        totalHours += Number(e.hours) || 0;
        if (e.workType === 'work' || e.workType === 'half-day') presentDays++;
      }
    });
  });
  return { totalHours, presentDays };
}

// ─── Helper: working days (Mon–Fri) in month ─────────────────────────────────
function getWorkingDays(month, year) {
  let count = 0;
  const days = new Date(year, month, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
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

  let total = 0;
  leaves.forEach(l => {
    const start = new Date(Math.max(new Date(l.startDate), monthStart));
    const end   = new Date(Math.min(new Date(l.endDate),   monthEnd));
    const days  = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
    total += Math.max(0, days);
  });
  return total;
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

// ─── GET /salary/preview — fetch defaults before generation ──────────────────
exports.getSalaryPreview = async (req, res) => {
  try {
    const { userId, month, year } = req.query;
    if (!userId || !month || !year) {
      return res.status(400).json({ message: 'userId, month, year are required' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'Employee not found' });

    const [{ totalHours, presentDays }, leaveBreakdown] = await Promise.all([
      getActualHours(Number(userId), Number(month), Number(year)),
      getLeaveBreakdown(Number(userId), Number(month), Number(year)),
    ]);

    const totalWorkDays = getWorkingDays(Number(month), Number(year));
    const leaveTaken    = leaveBreakdown.totalLeaveDays;
    const absentDays    = Math.max(0, totalWorkDays - presentDays - leaveTaken);
    const expectedHours = totalWorkDays * 8;
    const calDays       = new Date(Number(year), Number(month), 0).getDate();

    res.json({
      // Attendance summary
      leaveTaken,
      actualHours:  totalHours,
      presentDays,
      absentDays,
      totalWorkDays,
      expectedHours,
      calDays,
      holidayDays:  leaveBreakdown.holidayDays,
      leaveBreakdown: leaveBreakdown.breakdown,
      // Salary structure from profile
      baseSalary:       user.baseSalary        || 0,
      basicSalary:      user.basicSalary       || 0,
      hra:              user.hra               || 0,
      conveyance:       user.conveyance        || 0,
      medicalExpenses:  user.medicalExpenses   || 0,
      specialAllowance: user.specialAllowance  || 0,
      bonus:            user.bonus             || 0,
      ta:               user.ta                || 0,
      allowedLeave:     user.allowedLeavePerMonth || 2,
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
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department'] }],
      order: [['year', 'DESC'], ['month', 'DESC']],
    });
    res.json(salaries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

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

    const { totalHours, presentDays } = await getActualHours(userId, Number(month), Number(year));
    const defaultWorkingDays = getWorkingDays(Number(month), Number(year));
    const calDays = new Date(Number(year), Number(month), 0).getDate();
    const requestedWorkDays = parseInt(req.body.totalWorkDays, 10);
    const workingDays = Math.min(calDays, Math.max(0, requestedWorkDays || defaultWorkingDays));
    const leaveTakenAuto = await getLeaveTaken(userId, Number(month), Number(year));
    const leaveTakenValue = req.body.leaveTaken !== undefined ? parseFloat(req.body.leaveTaken) || 0 : leaveTakenAuto;
    const expectedHours = req.body.expectedHours !== undefined
      ? parseFloat(req.body.expectedHours) || 0
      : workingDays * 8;

    // Use request value if provided, else fall back to user's salary structure
    const p = (field, userField) =>
      req.body[field] !== undefined ? parseFloat(req.body[field]) || 0 : (user[userField || field] || 0);

    const salary = await Salary.create({
      userId,
      companyId: targetCompanyId,
      month: Number(month),
      year:  Number(year),
      // CTC & attendance
      baseSalary:   p('baseSalary',  'baseSalary'),
      leaveTaken:   leaveTakenValue,
      allowedLeave: p('allowedLeave', 'allowedLeavePerMonth'),
      // Earnings
      basicSalary:      p('basicSalary',      'basicSalary'),
      hra:              p('hra',              'hra'),
      conveyance:       p('conveyance',       'conveyance'),
      medicalExpenses:  p('medicalExpenses',  'medicalExpenses'),
      specialAllowance: p('specialAllowance', 'specialAllowance'),
      bonus:            p('bonus',            'bonus'),
      ta:               p('ta',               'ta'),
      // Deductions
      pfContribution:  p('pfContribution'),
      professionTax:   p('professionTax'),
      tds:             p('tds'),
      salaryAdvance:   p('salaryAdvance'),
      applyAbsentDeduction: req.body.applyAbsentDeduction !== undefined ? !!req.body.applyAbsentDeduction : true,
      manualDeductionDays: req.body.manualDeductionDays !== undefined ? parseFloat(req.body.manualDeductionDays) || 0 : 0,
      manualDeductionAmount: req.body.manualDeductionAmount !== undefined ? parseFloat(req.body.manualDeductionAmount) || 0 : 0,
      // Hours
      expectedHours,
      actualHours:   totalHours,
      // Days
      totalWorkDays: workingDays,
      presentDays,
      absentDays: Math.max(0, workingDays - presentDays - leaveTakenValue),
      notes:        req.body.notes || '',
      generatedBy:  req.user.id,
    });

    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
    });
    res.status(201).json(populated);
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

    const defaultWorkingDays = getWorkingDays(Number(month), Number(year));
    let created = 0, skipped = 0;

    for (const user of users) {
      const exists = await Salary.findOne({ where: { userId: user.id, month: Number(month), year: Number(year) } });
      if (exists) { skipped++; continue; }

      const { totalHours, presentDays } = await getActualHours(user.id, Number(month), Number(year));
      const leaveTakenAuto = await getLeaveTaken(user.id, Number(month), Number(year));
      const workingDays = defaultWorkingDays;

      await Salary.create({
        userId:    user.id,
        companyId,
        month:     Number(month),
        year:      Number(year),
        baseSalary:       user.baseSalary        || 0,
        leaveTaken:       leaveTakenAuto,
        allowedLeave:     user.allowedLeavePerMonth || 2,
        basicSalary:      user.basicSalary       || 0,
        hra:              user.hra                || 0,
        conveyance:       user.conveyance         || 0,
        medicalExpenses:  user.medicalExpenses    || 0,
        specialAllowance: user.specialAllowance   || 0,
        bonus:            user.bonus              || 0,
        ta:               user.ta                 || 0,
        pfContribution:   0,
        professionTax:    0,
        tds:              0,
        salaryAdvance:    0,
        applyAbsentDeduction: true,
        manualDeductionDays: 0,
        manualDeductionAmount: 0,
        expectedHours:    workingDays * 8,
        actualHours:      totalHours,
        totalWorkDays:    workingDays,
        presentDays,
        absentDays: Math.max(0, workingDays - presentDays - leaveTakenAuto),
        generatedBy: req.user.id,
      });
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
    const salary = await Salary.findByPk(req.params.id);
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (salary.status === 'paid') return res.status(400).json({ message: 'Cannot edit paid salary' });

    const editableFields = [
      'baseSalary', 'leaveTaken', 'allowedLeave',
      'basicSalary', 'hra', 'conveyance', 'medicalExpenses', 'specialAllowance', 'bonus', 'ta',
      'pfContribution', 'professionTax', 'tds', 'salaryAdvance',
      'expectedHours', 'totalWorkDays', 'notes', 'status', 'applyAbsentDeduction',
      'manualDeductionDays', 'manualDeductionAmount',
    ];
    editableFields.forEach(f => { if (req.body[f] !== undefined) salary[f] = req.body[f]; });

    if (req.body.totalWorkDays !== undefined || req.body.leaveTaken !== undefined || req.body.expectedHours !== undefined) {
      const calDays = new Date(salary.year, salary.month, 0).getDate();
      const workDays = Math.min(calDays, Math.max(0, parseInt(salary.totalWorkDays, 10) || 0));
      salary.totalWorkDays = workDays;
      const leaveTaken = parseFloat(salary.leaveTaken) || 0;
      salary.absentDays = Math.max(0, workDays - (salary.presentDays || 0) - leaveTaken);
      if (!req.body.expectedHours && workDays > 0) {
        salary.expectedHours = workDays * 8;
      }
    }

    if (req.body.status === 'finalized' && salary.changed('status')) {
      salary.finalizedBy = req.user.id;
      salary.finalizedAt = new Date();
    }

    await salary.save();

    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
    });
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── PATCH /salary/:id/pay ────────────────────────────────────────────────────
exports.paySalary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id);
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (salary.status !== 'finalized') return res.status(400).json({ message: 'Salary must be finalized before paying' });
    salary.status = 'paid';
    salary.paidAt = new Date();
    await salary.save();
    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
    });
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── DELETE /salary/:id ───────────────────────────────────────────────────────
exports.deleteSalary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id);
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
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
    let csv = 'Employee,Email,Department,Role,Period,CTC,Leave Taken,' +
      'Basic Salary,DA,HRA,Conveyance,Medical,Special,Bonus,TA,Gross Salary,' +
      'PF,Profession Tax,TDS,Salary Advance,Total Deductions,Net Salary,Status,Paid On\n';

    salaries.forEach(s => {
      csv += [
        `"${s.user?.name || ''}"`,
        s.user?.email || '',
        s.user?.department || '',
        s.user?.role || '',
        `${MONTHS[s.month - 1]} ${s.year}`,
        s.baseSalary,
        s.leaveTaken,
        s.basicSalary,
        s.da,
        s.hra,
        s.conveyanceWorking,
        s.medicalWorking,
        s.specialAllowance,
        s.bonus,
        s.ta,
        s.grossSalary,
        s.pfContribution,
        s.professionTax,
        s.tds,
        s.salaryAdvance,
        s.absentDeduction,
        s.manualDeductionDays,
        s.manualDeductionAmount,
        s.deductions,
        s.netSalary,
        s.status,
        s.paidAt ? new Date(s.paidAt).toLocaleDateString() : '',
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=salaries_${month || 'all'}_${year || 'all'}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /salary/:id/payslip ──────────────────────────────────────────────────
exports.generatePayslip = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department', 'phone', 'employeeCode'] },
        { model: Company, as: 'company' },
      ],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });

    const actor = req.user;
    if ((actor.role === 'employee' || actor.role === 'manager') && salary.userId !== actor.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const PDFDocument = require('pdfkit');
    const path = require('path');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const company = salary.company || {};
    const user = salary.user || {};
    const pageW = 595.28;
    const mL = 50;
    const cW = pageW - 100;
    const pageR = pageW - 50;
    const monthLabel = `${MONTHS[salary.month - 1]} ${salary.year}`;
    const calDays = new Date(salary.year, salary.month, 0).getDate();
    const workedDays = Math.max(0, calDays - (salary.leaveTaken || 0));
    const presentDays = salary.presentDays || 0;
    const employeeCode = user.employeeCode || `EMP-${String(user.id || salary.userId || 0).padStart(4, '0')}`;
    const generatedOn = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    const black = '#111111';
    const muted = '#666666';
    const red = '#c1121f';
    const border = '#d9d9d9';
    const white = '#ffffff';
    const fontRegular = path.join('C:', 'Windows', 'Fonts', 'arial.ttf');
    const fontBold = path.join('C:', 'Windows', 'Fonts', 'arialbd.ttf');

    function rowText(y, leftLabel, leftValue, rightLabel, rightValue) {
      doc.font(fontRegular).fontSize(8).fillColor(muted).text(leftLabel, mL + 8, y);
      doc.font(fontBold).fontSize(9).fillColor(black).text(String(leftValue || '-'), mL + 98, y, { width: 180 });
      doc.font(fontRegular).fontSize(8).fillColor(muted).text(rightLabel, 318, y);
      doc.font(fontBold).fontSize(9).fillColor(black).text(String(rightValue || '-'), 405, y, { width: 130 });
    }

    function statText(x, y, label, value) {
      doc.font(fontBold).fontSize(8).fillColor(black).text(label.toUpperCase(), x, y);
      doc.font(fontBold).fontSize(16).fillColor(black).text(String(value), x, y + 14);
    }

    function drawSplitRow(y, leftLabel, leftValue, rightLabel, rightValue) {
      const half = cW / 2;
      doc.rect(mL, y, half, 24).fillColor(white).fill();
      doc.rect(mL + half, y, half, 24).fillColor(white).fill();
      doc.strokeColor(border).lineWidth(1).moveTo(mL, y + 24).lineTo(pageR, y + 24).stroke();
      doc.strokeColor(border).lineWidth(1).moveTo(mL + half, y).lineTo(mL + half, y + 24).stroke();
      doc.font(fontRegular).fontSize(8).fillColor(black).text(leftLabel, mL + 12, y + 7);
      doc.font(fontBold).fontSize(8).fillColor(black).text(cur(leftValue), mL + half - 96, y + 7, { width: 84, align: 'right' });
      doc.font(fontRegular).fontSize(8).fillColor(black).text(rightLabel, mL + half + 12, y + 7);
      if (rightLabel) {
        doc.font(fontBold).fontSize(8).fillColor(black).text(cur(rightValue), pageR - 84, y + 7, { width: 72, align: 'right' });
      }
    }

    doc.rect(mL, 40, cW, 752).fillColor(white).strokeColor(border).lineWidth(1).fillAndStroke();

    doc.font(fontBold).fontSize(22).fillColor(black)
      .text(company.name || 'Company', mL, 58, { width: cW, align: 'center' });
    doc.font(fontRegular).fontSize(9).fillColor(muted)
      .text(company.address || '', mL + 24, 86, { width: cW - 48, align: 'center' })
      .text([company.phone, company.email].filter(Boolean).join(' | '), mL + 24, 100, { width: cW - 48, align: 'center' });
    doc.font(fontBold).fontSize(16).fillColor(black)
      .text('SALARY SLIP', mL, 126, { width: cW, align: 'center' });
    doc.font(fontRegular).fontSize(10).fillColor(red)
      .text(`For the month of ${monthLabel}`, mL, 146, { width: cW, align: 'center' });

    rowText(182, 'Employee Name:', user.name, 'Employee Code:', employeeCode);
    rowText(198, 'Department:', user.department, 'Designation:', user.role);
    rowText(214, 'Email:', user.email, 'Phone:', user.phone);
    rowText(230, 'Month:', monthLabel, 'CTC:', cur(salary.baseSalary));

    doc.moveTo(mL, 252).lineTo(pageR, 252).strokeColor(border).lineWidth(1).stroke();
    statText(mL + 12, 264, 'Total Day', calDays);
    statText(mL + 146, 264, 'Leave Taken', salary.leaveTaken || 0);
    statText(mL + 280, 264, 'Worked Day', workedDays);
    statText(mL + 414, 264, 'Present Day', presentDays);
    doc.moveTo(mL, 312).lineTo(pageR, 312).strokeColor(border).lineWidth(1).stroke();

    const half = cW / 2;
    doc.font(fontBold).fontSize(10).fillColor(black).text('Earnings', mL + 12, 328);
    doc.font(fontBold).fontSize(10).fillColor(red).text('Deductions', mL + half + 12, 328);

    const earnings = [
      ['Basic Salary', salary.basicSalary || 0],
      ['DA (Dearness Allow.)', salary.da || 0],
      ['HRA', salary.hra || 0],
      ['Conveyance', salary.conveyanceWorking || salary.conveyance || 0],
      ['Medical Expenses', salary.medicalWorking || salary.medicalExpenses || 0],
      ['Special Allowance', salary.specialAllowance || 0],
      ['Bonus', salary.bonus || 0],
      ['Travel Allow. (TA)', salary.ta || 0],
    ];
    const absentLabel = (salary.manualDeductionAmount || 0) > 0
      ? 'Deduction (Admin set)'
      : 'Absent Deduction';

    const deductions = [
      ['PF Contribution', salary.pfContribution || 0],
      ['Profession Tax', salary.professionTax || 0],
      ['TDS', salary.tds || 0],
      ['Salary Advance', salary.salaryAdvance || 0],
      [absentLabel, salary.absentDeduction || 0],
      ['', 0],
      ['', 0],
      ['', 0],
    ];

    let y = 344;
    for (let i = 0; i < earnings.length; i++) {
      drawSplitRow(y, earnings[i][0], earnings[i][1], deductions[i][0], deductions[i][1]);
      y += 24;
    }

    doc.rect(mL, y, half, 28).fillColor(white).strokeColor(border).lineWidth(1).fillAndStroke();
    doc.rect(mL + half, y, half, 28).fillColor(white).strokeColor(border).lineWidth(1).fillAndStroke();
    doc.font(fontBold).fontSize(9).fillColor(black).text('Gross Salary', mL + 12, y + 9);
    doc.font(fontBold).fontSize(9).fillColor(black).text(cur(salary.grossSalary), mL + half - 96, y + 9, { width: 84, align: 'right' });
    doc.font(fontBold).fontSize(9).fillColor(red).text('Total Deductions', mL + half + 12, y + 9);
    doc.font(fontBold).fontSize(9).fillColor(black).text(cur(salary.deductions), pageR - 84, y + 9, { width: 72, align: 'right' });

    doc.rect(mL + 10, y + 46, cW - 20, 44).fillColor(black).fill();
    doc.font(fontBold).fontSize(14).fillColor(white).text('NET PAY', mL + 26, y + 61);
    doc.font(fontBold).fontSize(22).fillColor(white).text(cur(salary.netSalary), pageR - 160, y + 56, { width: 132, align: 'right' });

    doc.font(fontRegular).fontSize(8).fillColor(muted)
      .text(numberToWords(salary.netSalary), mL + 10, y + 102, { width: cW - 20 });

    const footerY = 720;
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
        .text(`Note: ${salary.notes}`, mL + 10, 772, { width: cW - 20 });
    }

    const pdfBuffer = await new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    const mode = req.query.mode || 'download';
    const fname = `payslip_${salary.user?.name?.replace(/\s+/g, '_')}_${salary.month}_${salary.year}.pdf`;
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

function cur(n) {
  return '₹ ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
