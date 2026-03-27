const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Task = sequelize.define('Task', {
  title:       { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, defaultValue: '' },
  assignedTo:  { type: DataTypes.INTEGER, allowNull: false },
  assignedBy:  { type: DataTypes.INTEGER, allowNull: false },
  companyId:   { type: DataTypes.INTEGER, allowNull: true },
  dueDate:     { type: DataTypes.DATEONLY, allowNull: true },
  priority:    { type: DataTypes.STRING(20), defaultValue: 'medium' },
  status:      { type: DataTypes.STRING(20), defaultValue: 'todo' },
  completedAt: { type: DataTypes.DATE, allowNull: true },

  // Approval workflow
  approvalStatus: {
    type: DataTypes.STRING(30),
    defaultValue: 'none',
  },
  refusalReason: { type: DataTypes.TEXT, defaultValue: '' },
  refusedAt:     { type: DataTypes.DATE, allowNull: true },
}, { timestamps: true });

module.exports = Task;
