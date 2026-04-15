const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  name:          { type: DataTypes.STRING, allowNull: false },
  email:         { type: DataTypes.STRING, allowNull: false, unique: true },
  password:      { type: DataTypes.STRING, allowNull: false },
  role:          { type: DataTypes.STRING(20), defaultValue: 'employee' },
  companyId:     { type: DataTypes.INTEGER, allowNull: true },
  managerId:     { type: DataTypes.INTEGER, allowNull: true },
  baseSalary:    { type: DataTypes.FLOAT, defaultValue: 0 },  // CTC (monthly)
  // Salary structure components (DHPE style)
  basicSalary:      { type: DataTypes.FLOAT, defaultValue: 0 },
  da:               { type: DataTypes.FLOAT, defaultValue: 0 },
  hra:              { type: DataTypes.FLOAT, defaultValue: 0 },
  conveyance:       { type: DataTypes.FLOAT, defaultValue: 0 },
  medicalExpenses:  { type: DataTypes.FLOAT, defaultValue: 0 },
  specialAllowance: { type: DataTypes.FLOAT, defaultValue: 0 },
  bonus:            { type: DataTypes.FLOAT, defaultValue: 0 },
  ta:               { type: DataTypes.FLOAT, defaultValue: 0 },
  pfApplicable:         { type: DataTypes.BOOLEAN, defaultValue: true },
  allowedLeavePerMonth: { type: DataTypes.INTEGER, defaultValue: 2 },
  status:        { type: DataTypes.STRING(20), defaultValue: 'active' },
  // Verification workflow for employees
  verificationStatus: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
  department:    { type: DataTypes.STRING, defaultValue: '' },
  position:      { type: DataTypes.STRING, defaultValue: '' },    // Job designation
  phone:         { type: DataTypes.STRING, defaultValue: '' },
  gender:        { type: DataTypes.STRING(20), defaultValue: 'unspecified' },
  profilePhoto:  { type: DataTypes.STRING, defaultValue: '' },
  employeeCode:  { type: DataTypes.STRING, allowNull: true, unique: true }, // e.g. EMP-0001
  currency:      { type: DataTypes.STRING(10), defaultValue: 'INR' },
}, { timestamps: true });

// Hash password before create
async function generateUniqueEmployeeCode(companyId) {
  const where = companyId ? { companyId } : {};
  const users = await User.findAll({
    where,
    attributes: ['employeeCode'],
  });

  let maxNum = 0;
  users.forEach((u) => {
    const code = u.employeeCode || '';
    const match = /^EMP-(\d+)$/.exec(code);
    if (match) {
      const num = parseInt(match[1], 10) || 0;
      if (num > maxNum) maxNum = num;
    }
  });

  let nextNum = maxNum + 1;
  let nextCode = '';
  let exists = true;

  while (exists) {
    nextCode = 'EMP-' + String(nextNum).padStart(4, '0');
    exists = !!(await User.findOne({ where: { employeeCode: nextCode } }));
    nextNum += 1;
  }

  return nextCode;
}

User.beforeCreate(async (user) => {
  user.password = await bcrypt.hash(user.password, 10);
  // Auto-generate employee code for employees/managers using next unused code
  if ((user.role === 'employee' || user.role === 'manager') && !user.employeeCode) {
    user.employeeCode = await generateUniqueEmployeeCode(user.companyId);
  }
});

User.beforeUpdate(async (user) => {
  if (user.changed('password')) {
    user.password = await bcrypt.hash(user.password, 10);
  }
});

User.prototype.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

module.exports = User;
