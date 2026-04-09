const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WorkOrder = sequelize.define('WorkOrder', {
  woNumber:  { type: DataTypes.STRING(50),  allowNull: false },
  type:      { type: DataTypes.ENUM('CWO','VWO'), allowNull: false },

  clientId:  { type: DataTypes.INTEGER,     allowNull: true },
  vendorId:  { type: DataTypes.INTEGER,     allowNull: true },
  partyName: { type: DataTypes.STRING(200), defaultValue: '' },

  projectAccountId: { type: DataTypes.INTEGER,   allowNull: true },
  projectName:      { type: DataTypes.STRING(300), defaultValue: '' },

  startDate: { type: DataTypes.DATEONLY, allowNull: true },
  endDate:   { type: DataTypes.DATEONLY, allowNull: true },
  scope:     { type: DataTypes.TEXT,     defaultValue: '' },

  totalAmount: { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },

  milestones: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() { try { return JSON.parse(this.getDataValue('milestones') || '[]'); } catch(e) { return []; } },
    set(v) { this.setDataValue('milestones', JSON.stringify(v || [])); },
  },

  status: {
    type: DataTypes.ENUM('Draft','Proposed','Active','Completed','Cancelled'),
    defaultValue: 'Draft',
  },
  createdBy: { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = WorkOrder;
