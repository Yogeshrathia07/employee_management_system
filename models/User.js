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
User.beforeCreate(async (user) => {
  user.password = await bcrypt.hash(user.password, 10);
  // Auto-generate employee code for employees
  if (user.role === 'employee' || user.role === 'manager') {
    const count = await User.count({ where: user.companyId ? { companyId: user.companyId } : {} });
    user.employeeCode = 'EMP-' + String(count + 1).padStart(4, '0');
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
