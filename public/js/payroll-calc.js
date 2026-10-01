/* ═══════════════════════════════════════════════════════════════════════════
   Payroll formula — the single definition used everywhere a salary is shown:
   the Salary model (stored totals), the PDF payslip, the payroll sheet and the
   on-screen payslip. Loaded with require() on the server and as
   window.PayrollCalc in the browser, so every view shows the same numbers.

   1. Total Days     = days in the pay period (calendar days of the month by default)
   2. Paid Leave     = min(Leave Taken, Allowed Leave)
      LOP Days       = Leave Taken − Allowed Leave (when positive)
   3. Worked Days    = Total Days − LOP Days (admin may reduce it further for
                       unauthorised absence; it can never exceed this maximum)
      Present Days   = Worked Days − Paid Leave
   4. CTC            = Basic + DA + HRA + Conveyance + Medical + Special + Bonus + TA
   5. Conveyance     = Conveyance ÷ Total Days × Worked Days (rounded to ₹10)
   6. Gross Salary   = Basic + DA + HRA + Conveyance (working) + Medical
                       + Special + Bonus + TA
   7. Absent / LOP   = (CTC − Conveyance) ÷ Total Days × (Total Days − Worked Days),
      deduction        rounded to ₹10 — or the manual "Deduction (₹)" when entered
   8. Deductions     = PF + Profession Tax + TDS + Salary Advance + Absent/LOP
   9. Net Pay        = Gross Salary − Deductions (never below 0)
   PF default (PF applicable) = 12% of (Basic + DA), capped at ₹1,800.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PayrollCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function hasValue(value) {
    return value !== null && value !== undefined && value !== '' && isFinite(parseFloat(value));
  }

  function round2(value) {
    return Math.round((num(value) + Number.EPSILON) * 100) / 100;
  }

  // DHPE sheet rounding: nearest ₹10
  function r10(value) {
    return Math.round(num(value) / 10) * 10;
  }

  function daysInMonth(month, year) {
    var m = parseInt(month, 10);
    var y = parseInt(year, 10);
    return m >= 1 && m <= 12 && y > 0 ? new Date(y, m, 0).getDate() : 30;
  }

  function defaultPf(basicSalary, da) {
    return Math.min(1800, Math.round((num(basicSalary) + num(da)) * 0.12));
  }

  function compute(input) {
    input = input || {};
    var totalDays = num(input.totalDays) > 0 ? num(input.totalDays) : daysInMonth(input.month, input.year);
    var allowedLeave = Math.max(0, num(input.allowedLeave));
    var leaveTaken = Math.max(0, num(input.leaveTaken));
    var paidLeave = Math.min(leaveTaken, allowedLeave);
    var lopDays = Math.max(0, leaveTaken - allowedLeave);
    var maxWorkedDays = Math.max(0, totalDays - lopDays);
    var workedDays = hasValue(input.workedDays)
      ? Math.min(Math.max(0, num(input.workedDays)), maxWorkedDays)
      : maxWorkedDays;
    var unpaidDays = Math.max(0, totalDays - workedDays);
    var presentDays = Math.max(0, workedDays - paidLeave);

    var basicSalary = num(input.basicSalary);
    var da = num(input.da);
    var hra = num(input.hra);
    var conveyance = num(input.conveyance);
    var medicalExpenses = num(input.medicalExpenses);
    var specialAllowance = num(input.specialAllowance);
    var bonus = num(input.bonus);
    var ta = num(input.ta);

    var ctc = basicSalary + da + hra + conveyance + medicalExpenses + specialAllowance + bonus + ta;
    var conveyanceWorking = workedDays >= totalDays || totalDays <= 0
      ? conveyance
      : r10(conveyance / totalDays * workedDays);
    var medicalWorking = medicalExpenses;
    var grossSalary = basicSalary + da + hra + conveyanceWorking + medicalWorking + specialAllowance + bonus + ta;

    var perDayRate = totalDays > 0 ? (ctc - conveyance) / totalDays : 0;
    var manualDeductionAmount = Math.max(0, num(input.manualDeductionAmount));
    var applyAbsent = input.applyAbsentDeduction !== false;
    var absentDeduction = manualDeductionAmount > 0
      ? r10(manualDeductionAmount)
      : (applyAbsent ? r10(perDayRate * unpaidDays) : 0);

    var pfContribution = num(input.pfContribution);
    var professionTax = num(input.professionTax);
    var tds = num(input.tds);
    var salaryAdvance = num(input.salaryAdvance);
    var totalDeductions = pfContribution + professionTax + tds + salaryAdvance + absentDeduction;
    var netSalary = Math.max(0, grossSalary - totalDeductions);

    return {
      totalDays: totalDays,
      allowedLeave: allowedLeave,
      leaveTaken: leaveTaken,
      paidLeave: paidLeave,
      lopDays: lopDays,
      maxWorkedDays: maxWorkedDays,
      workedDays: workedDays,
      unpaidDays: unpaidDays,
      presentDays: presentDays,
      ctc: round2(ctc),
      basicSalary: basicSalary,
      da: da,
      hra: hra,
      conveyance: conveyance,
      conveyanceWorking: round2(conveyanceWorking),
      medicalExpenses: medicalExpenses,
      medicalWorking: round2(medicalWorking),
      specialAllowance: specialAllowance,
      bonus: bonus,
      ta: ta,
      grossSalary: round2(grossSalary),
      allowances: round2(grossSalary - basicSalary),
      perDayRate: round2(perDayRate),
      manualDeductionAmount: manualDeductionAmount,
      absentDeduction: round2(absentDeduction),
      absentDeductionIsManual: manualDeductionAmount > 0,
      pfContribution: pfContribution,
      professionTax: professionTax,
      tds: tds,
      salaryAdvance: salaryAdvance,
      totalDeductions: round2(totalDeductions),
      netSalary: round2(netSalary),
    };
  }

  return {
    compute: compute,
    defaultPf: defaultPf,
    daysInMonth: daysInMonth,
    r10: r10,
  };
});
