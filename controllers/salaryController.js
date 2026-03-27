const { Op } = require('sequelize');
const { Salary, Timesheet, User, Company } = require('../models');

// ─── Helper: get actual hours from approved timesheets ───
async function getActualHours(userId, month, year) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0, 23, 59, 59);

  // Find any timesheet whose date range OVERLAPS with the target month
  // A timesheet overlaps if weekStart <= monthEnd AND weekEnd >= monthStart
  const timesheets = await Timesheet.findAll({
    where: {
      userId,
      status: 'approved',
      weekStart: { [Op.lte]: monthEnd },
      weekEnd: { [Op.gte]: monthStart },
    },
  });

  let totalHours = 0;
  let presentDays = 0;

  timesheets.forEach(ts => {
    let entries = ts.entries || [];
    // MySQL JSON columns may return a string — parse if needed
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch(e) { entries = []; }
    }
    if (!Array.isArray(entries)) entries = [];
    // Only count entries whose date falls within the target month
    entries.forEach(e => {
      const entryDate = new Date(e.date);
      if (entryDate >= monthStart && entryDate <= monthEnd) {
        totalHours += Number(e.hours) || 0;
        if (e.workType === 'work' || e.workType === 'half-day') {
          presentDays++;
        }
      }
    });
  });

  return { totalHours, presentDays };
}

// ─── Helper: count working days in a month (Mon-Fri) ───
function getWorkingDays(month, year) {
  let count = 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// ─── GET /salary ───
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
    // superadmin sees all — can filter by companyId
    if (req.user.role === 'superadmin' && req.query.companyId) {
      where.companyId = req.query.companyId;
    }

    if (req.query.month) where.month = Number(req.query.month);
    if (req.query.year) where.year = Number(req.query.year);

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

// ─── POST /salary — single employee ───
exports.createSalary = async (req, res) => {
  try {
    const { userId, month, year, baseSalary, expectedHours, allowances, deductions, overtime, notes, companyId: requestedCompanyId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Employee is required' });
    if (!month || month < 1 || month > 12) return res.status(400).json({ message: 'Valid month (1-12) is required' });
    if (!year || year < 2000 || year > 2100) return res.status(400).json({ message: 'Valid year is required' });

    const exists = await Salary.findOne({ where: { userId, month, year } });
    if (exists) return res.status(400).json({ message: 'Salary record already exists for this month/year' });

    const { totalHours, presentDays } = await getActualHours(userId, month, year);
    const workingDays = getWorkingDays(month, year);
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'Employee not found' });

    let targetCompanyId = req.user.companyId || user.companyId || null;
    if (req.user.role === 'superadmin') {
      targetCompanyId = Number(requestedCompanyId || user.companyId || 0) || null;
      if (!targetCompanyId) return res.status(400).json({ message: 'Select a company first' });
    }

    if (req.user.role !== 'superadmin' && req.user.companyId && user.companyId !== req.user.companyId) {
      return res.status(403).json({ message: 'You can only generate payroll for your own company' });
    }

    const salary = await Salary.create({
      userId,
      companyId: targetCompanyId,
      month: Number(month),
      year: Number(year),
      baseSalary: baseSalary || user.baseSalary || 0,
      expectedHours: expectedHours || workingDays * 8,
      actualHours: totalHours,
      allowances: allowances || 0,
      deductions: deductions || 0,
      overtime: overtime || 0,
      notes,
      totalWorkDays: workingDays,
      presentDays,
      absentDays: Math.max(0, workingDays - presentDays),
      generatedBy: req.user.id,
    });

    const populated = await Salary.findByPk(salary.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
    });
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /salary/generate-bulk — auto-generate for all employees in company ───
exports.generateBulk = async (req, res) => {
  try {
    const { month, year, expectedHours, companyId: requestedCompanyId } = req.body;
    if (!month || !year) return res.status(400).json({ message: 'Month and year are required' });
    if (month < 1 || month > 12) return res.status(400).json({ message: 'Valid month (1-12) is required' });
    if (year < 2000 || year > 2100) return res.status(400).json({ message: 'Valid year is required' });

    const companyId = req.user.role === 'superadmin'
      ? Number(requestedCompanyId || 0)
      : req.user.companyId;

    if (!companyId) return res.status(400).json({ message: 'Select a company before generating payroll' });

    const users = await User.findAll({
      where: { companyId, status: 'active', role: { [Op.in]: ['employee', 'manager'] } },
    });

    const workingDays = getWorkingDays(month, year);
    const expHrs = expectedHours || workingDays * 8;
    let created = 0, skipped = 0;

    for (const user of users) {
      const exists = await Salary.findOne({ where: { userId: user.id, month: Number(month), year: Number(year) } });
      if (exists) { skipped++; continue; }

      const { totalHours, presentDays } = await getActualHours(user.id, month, year);

      await Salary.create({
        userId: user.id,
        companyId,
        month: Number(month),
        year: Number(year),
        baseSalary: user.baseSalary || 0,
        expectedHours: expHrs,
        actualHours: totalHours,
        allowances: 0,
        deductions: 0,
        overtime: 0,
        totalWorkDays: workingDays,
        presentDays,
        absentDays: Math.max(0, workingDays - presentDays),
        generatedBy: req.user.id,
      });
      created++;
    }

    res.json({ message: `Generated ${created} salary records, ${skipped} already existed`, created, skipped });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── PUT /salary/:id ───
exports.updateSalary = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id);
    if (!salary) return res.status(404).json({ message: 'Salary not found' });
    if (salary.status === 'paid') return res.status(400).json({ message: 'Cannot edit paid salary' });

    const fields = ['baseSalary', 'expectedHours', 'allowances', 'deductions', 'overtime', 'notes', 'status'];
    fields.forEach(f => { if (req.body[f] !== undefined) salary[f] = req.body[f]; });

    // Track who finalized
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

// ─── PATCH /salary/:id/pay ───
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

// ─── DELETE /salary/:id ───
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

// ─── GET /salary/export/csv ───
exports.exportCSV = async (req, res) => {
  try {
    const { month, year } = req.query;
    const where = {};

    // Superadmin sees all, admin sees own company
    if (req.user.role === 'admin') {
      where.companyId = req.user.companyId;
    }
    // superadmin: no companyId filter — exports everything

    if (month) where.month = Number(month);
    if (year) where.year = Number(year);

    const salaries = await Salary.findAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department'] }],
      order: [['year', 'DESC'], ['month', 'DESC']],
    });

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let csv = 'Employee,Email,Department,Role,Period,Base Salary,Allowances,Overtime Pay,Gross Salary,Deductions,Absent Deduction,Net Salary,Expected Hours,Actual Hours,Status,Paid On\n';

    salaries.forEach(s => {
      csv += [
        `"${s.user?.name || ''}"`,
        s.user?.email || '',
        s.user?.department || '',
        s.user?.role || '',
        `${MONTHS[s.month-1]} ${s.year}`,
        s.baseSalary,
        s.allowances,
        s.overtimePay,
        s.grossSalary,
        s.deductions,
        s.absentDeduction,
        s.netSalary,
        s.expectedHours,
        s.actualHours,
        s.status,
        s.paidAt ? new Date(s.paidAt).toLocaleDateString() : '',
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=salaries_${month||'all'}_${year||'all'}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /salary/:id/payslip — generate PDF payslip ───
exports.generatePayslip = async (req, res) => {
  try {
    const salary = await Salary.findByPk(req.params.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'department', 'phone'] },
        { model: Company, as: 'company' },
      ],
    });
    if (!salary) return res.status(404).json({ message: 'Salary not found' });

    // Check permission: employee can only see own, admin/superadmin can see all
    const actor = req.user;
    if (actor.role === 'employee' || actor.role === 'manager') {
      if (salary.userId !== actor.id) return res.status(403).json({ message: 'Access denied' });
    }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    // If ?mode=view, show inline; otherwise download
    const mode = req.query.mode || 'download';
    res.setHeader('Content-Type', 'application/pdf');
    if (mode === 'view') {
      res.setHeader('Content-Disposition', `inline; filename=payslip_${salary.user?.name?.replace(/\s+/g,'_')}_${salary.month}_${salary.year}.pdf`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename=payslip_${salary.user?.name?.replace(/\s+/g,'_')}_${salary.month}_${salary.year}.pdf`);
    }
    doc.pipe(res);

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const company = salary.company || {};
    const user = salary.user || {};
    const pageW = 595.28;
    const marginL = 50;
    const contentW = pageW - 100;

    // ─── Header ───
    doc.fontSize(18).font('Helvetica-Bold').text(company.name || 'Company', marginL, 50, { width: contentW, align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#666666')
      .text(company.address || '', marginL, 72, { width: contentW, align: 'center' })
      .text([company.phone, company.email].filter(Boolean).join('  |  '), { width: contentW, align: 'center' });

    // Divider
    doc.moveTo(marginL, 100).lineTo(pageW - 50, 100).strokeColor('#cccccc').lineWidth(1).stroke();

    // Title
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#000000')
      .text('SALARY SLIP', marginL, 112, { width: contentW, align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#555555')
      .text(`For the month of ${MONTHS[salary.month-1]} ${salary.year}`, marginL, 128, { width: contentW, align: 'center' });

    // ─── Employee Details ───
    const detY = 155;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000');

    const col1 = marginL;
    const col2 = marginL + 120;
    const col3 = 320;
    const col4 = 440;

    const labelColor = '#555555';
    const valueColor = '#000000';

    function row(y, l1, v1, l2, v2) {
      doc.font('Helvetica').fontSize(9).fillColor(labelColor).text(l1, col1, y);
      doc.font('Helvetica-Bold').fillColor(valueColor).text(v1, col2, y);
      if (l2) {
        doc.font('Helvetica').fillColor(labelColor).text(l2, col3, y);
        doc.font('Helvetica-Bold').fillColor(valueColor).text(v2 || '', col4, y);
      }
    }

    row(detY, 'Employee Name:', user.name || '—', 'Employee ID:', `EMP-${String(user.id).padStart(4, '0')}`);
    row(detY + 16, 'Department:', user.department || '—', 'Designation:', user.role || '—');
    row(detY + 32, 'Email:', user.email || '—', 'Phone:', user.phone || '—');

    // Divider
    doc.moveTo(marginL, detY + 55).lineTo(pageW - 50, detY + 55).strokeColor('#eeeeee').stroke();

    // ─── Earnings & Deductions table ───
    const tableY = detY + 70;
    const halfW = contentW / 2 - 5;

    // Earnings header
    doc.rect(col1, tableY, halfW, 22).fillColor('#f3f4f6').fill();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
      .text('Earnings', col1 + 10, tableY + 6);

    // Deductions header
    doc.rect(col1 + halfW + 10, tableY, halfW, 22).fillColor('#f3f4f6').fill();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
      .text('Deductions', col1 + halfW + 20, tableY + 6);

    function earningRow(y, label, amount) {
      doc.fontSize(9).font('Helvetica').fillColor(labelColor).text(label, col1 + 10, y);
      doc.font('Helvetica-Bold').fillColor(valueColor).text(currency(amount), col1 + halfW - 80, y, { width: 70, align: 'right' });
    }

    function deductionRow(y, label, amount) {
      doc.fontSize(9).font('Helvetica').fillColor(labelColor).text(label, col1 + halfW + 20, y);
      doc.font('Helvetica-Bold').fillColor('#dc2626').text(currency(amount), col1 + contentW - 80, y, { width: 70, align: 'right' });
    }

    const rY = tableY + 30;
    earningRow(rY, 'Basic Salary', salary.baseSalary);
    earningRow(rY + 18, 'Allowances', salary.allowances);
    earningRow(rY + 36, 'Overtime Pay', salary.overtimePay);

    // Earnings total
    doc.moveTo(col1, rY + 58).lineTo(col1 + halfW, rY + 58).strokeColor('#dddddd').stroke();
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
      .text('Gross Earnings', col1 + 10, rY + 64)
      .text(currency(salary.grossSalary), col1 + halfW - 80, rY + 64, { width: 70, align: 'right' });

    deductionRow(rY, 'Other Deductions', salary.deductions);
    deductionRow(rY + 18, 'Absent Deduction', salary.absentDeduction);

    // Deductions total
    doc.moveTo(col1 + halfW + 10, rY + 58).lineTo(col1 + contentW, rY + 58).strokeColor('#dddddd').stroke();
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#dc2626')
      .text('Total Deductions', col1 + halfW + 20, rY + 64)
      .text(currency(salary.deductions + salary.absentDeduction), col1 + contentW - 80, rY + 64, { width: 70, align: 'right' });

    // ─── Net Pay Box ───
    const netY = rY + 95;
    doc.rect(col1, netY, contentW, 36).fillColor('#111111').fill();
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#ffffff')
      .text('NET PAY', col1 + 20, netY + 10)
      .text(currency(salary.netSalary), col1 + contentW - 170, netY + 10, { width: 150, align: 'right' });

    // ─── Attendance Summary ───
    const attY = netY + 55;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000').text('Attendance Summary', col1, attY);
    doc.moveTo(col1, attY + 15).lineTo(col1 + 200, attY + 15).strokeColor('#eeeeee').stroke();

    const aY = attY + 22;
    doc.fontSize(9).font('Helvetica').fillColor(labelColor);
    doc.text('Working Days:', col1, aY); doc.font('Helvetica-Bold').fillColor(valueColor).text(String(salary.totalWorkDays), col1 + 100, aY);
    doc.font('Helvetica').fillColor(labelColor).text('Present Days:', col1, aY + 16); doc.font('Helvetica-Bold').fillColor(valueColor).text(String(salary.presentDays), col1 + 100, aY + 16);
    doc.font('Helvetica').fillColor(labelColor).text('Absent Days:', col1, aY + 32); doc.font('Helvetica-Bold').fillColor('#dc2626').text(String(salary.absentDays), col1 + 100, aY + 32);
    doc.font('Helvetica').fillColor(labelColor).text('Expected Hours:', col3, aY); doc.font('Helvetica-Bold').fillColor(valueColor).text(String(salary.expectedHours) + 'h', col4, aY);
    doc.font('Helvetica').fillColor(labelColor).text('Actual Hours:', col3, aY + 16); doc.font('Helvetica-Bold').fillColor(valueColor).text(String(salary.actualHours) + 'h', col4, aY + 16);
    doc.font('Helvetica').fillColor(labelColor).text('Overtime Hours:', col3, aY + 32); doc.font('Helvetica-Bold').fillColor(valueColor).text(String(salary.overtime) + 'h', col4, aY + 32);

    // ─── Footer ───
    const footY = 680;
    doc.moveTo(marginL, footY).lineTo(pageW - 50, footY).strokeColor('#cccccc').stroke();

    // Authorized signatory
    doc.fontSize(9).font('Helvetica').fillColor(labelColor)
      .text('Authorized Signatory', pageW - 200, footY + 15, { width: 150, align: 'center' });
    if (company.authorizedSignatory) {
      doc.font('Helvetica-Bold').fillColor(valueColor)
        .text(company.authorizedSignatory, pageW - 200, footY + 30, { width: 150, align: 'center' });
    }

    // Generated date
    doc.fontSize(8).font('Helvetica').fillColor('#999999')
      .text(`Generated on ${new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' })}`, marginL, footY + 15);
    doc.text('This is a computer-generated document.', marginL, footY + 28);

    if (salary.notes) {
      doc.fontSize(8).font('Helvetica').fillColor(labelColor)
        .text(`Note: ${salary.notes}`, marginL, footY + 45, { width: contentW });
    }

    doc.end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

function currency(n) {
  return 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

