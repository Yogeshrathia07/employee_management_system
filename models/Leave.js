const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Leave = sequelize.define('Leave', {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  type: { type: DataTypes.STRING(20), defaultValue: 'annual' },
  startDate: { type: DataTypes.DATEONLY, allowNull: false },
  endDate: { type: DataTypes.DATEONLY, allowNull: false },
  days: { type: DataTypes.INTEGER, allowNull: false },
  reason: { type: DataTypes.TEXT, defaultValue: '' },
  status: { type: DataTypes.STRING(20), defaultValue: 'pending' },
  approvedBy: { type: DataTypes.INTEGER, allowNull: true },
  approvedAt: { type: DataTypes.DATE, allowNull: true },
  rejectionReason: { type: DataTypes.TEXT, defaultValue: '' },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = Leave;
