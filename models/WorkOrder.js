const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WorkOrder = sequelize.define('WorkOrder', {
  woNumber:  { type: DataTypes.STRING(50),  allowNull: false },
  type:      { type: DataTypes.ENUM('CWO','VWO'), allowNull: false },
  companyId: { type: DataTypes.INTEGER, allowNull: true },

  clientId:  { type: DataTypes.INTEGER,     allowNull: true },
  vendorId:  { type: DataTypes.INTEGER,     allowNull: true },
  partyName: { type: DataTypes.STRING(200), defaultValue: '' },

  sellerName:      { type: DataTypes.STRING(200), defaultValue: '' },
  sellerAddress:   { type: DataTypes.TEXT },
  sellerPhone:     { type: DataTypes.STRING(50), defaultValue: '' },
  sellerEmail:     { type: DataTypes.STRING(200), defaultValue: '' },
  sellerGstin:     { type: DataTypes.STRING(20), defaultValue: '' },
  sellerPan:       { type: DataTypes.STRING(20), defaultValue: '' },
  sellerState:     { type: DataTypes.STRING(120), defaultValue: '' },
  sellerStateCode: { type: DataTypes.STRING(5), defaultValue: '' },
  sellerAuthorizedSignatory: { type: DataTypes.STRING(200), defaultValue: '' },

  bankName:    { type: DataTypes.STRING(200), defaultValue: '' },
  bankAcName:  { type: DataTypes.STRING(200), defaultValue: '' },
  bankAccount: { type: DataTypes.STRING(120), defaultValue: '' },
  bankIfsc:    { type: DataTypes.STRING(40), defaultValue: '' },
  bankBranch:  { type: DataTypes.STRING(200), defaultValue: '' },

  projectAccountId: { type: DataTypes.INTEGER,   allowNull: true },
  projectCode:      { type: DataTypes.STRING(60), defaultValue: '' },
  projectName:      { type: DataTypes.STRING(300), defaultValue: '' },
  noticeType:       { type: DataTypes.STRING(10), defaultValue: '' },
  tenderReferenceNo:{ type: DataTypes.STRING(200), defaultValue: '' },
  tenderId:         { type: DataTypes.STRING(200), defaultValue: '' },
  tenderNo:         { type: DataTypes.STRING(200), defaultValue: '' },
  quotedRate:       { type: DataTypes.STRING(200), defaultValue: '' },
  timeOfCompletion: { type: DataTypes.STRING(200), defaultValue: '' },
  sourceOfFund:     { type: DataTypes.STRING(300), defaultValue: '' },
  annexurePdfPath:  { type: DataTypes.STRING(255), defaultValue: '' },
  annexurePdfName:  { type: DataTypes.STRING(255), defaultValue: '' },

  startDate: { type: DataTypes.DATEONLY, allowNull: true },
  endDate:   { type: DataTypes.DATEONLY, allowNull: true },
  scope:     { type: DataTypes.TEXT },

  totalAmount: { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },

  milestones: {
    type: DataTypes.TEXT,
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
