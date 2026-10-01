const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Project master data — selectable in timesheets and summarised on payslips.
const Project = sequelize.define('Project', {
  code:        { type: DataTypes.STRING(30),  defaultValue: '' },
  name:        { type: DataTypes.STRING(200), allowNull: false },
  description: { type: DataTypes.TEXT },
  clientName:  { type: DataTypes.STRING(200), defaultValue: '' },
  location:    { type: DataTypes.STRING(200), defaultValue: '' },
  startDate:   { type: DataTypes.DATEONLY,    allowNull: true },
  endDate:     { type: DataTypes.DATEONLY,    allowNull: true },
  status:      { type: DataTypes.STRING(20),  defaultValue: 'active' }, // active | completed | on_hold
  managerId:   { type: DataTypes.INTEGER,     allowNull: true },
  companyId:   { type: DataTypes.INTEGER,     allowNull: true },
  createdBy:   { type: DataTypes.INTEGER,     allowNull: true },
}, { timestamps: true });

module.exports = Project;
