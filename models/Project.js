const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Project = sequelize.define('Project', {
  name:        { type: DataTypes.STRING(200), allowNull: false },
  description: { type: DataTypes.TEXT,        defaultValue: '' },
  status:      { type: DataTypes.STRING(20),  defaultValue: 'active' }, // active | completed | on_hold
  managerId:   { type: DataTypes.INTEGER,     allowNull: false },
  companyId:   { type: DataTypes.INTEGER,     allowNull: true },
  createdBy:   { type: DataTypes.INTEGER,     allowNull: true },
}, { timestamps: true });

module.exports = Project;
