const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PurchaseOrder = sequelize.define('PurchaseOrder', {
  poNumber:   { type: DataTypes.STRING(50),  allowNull: false },
  vendorId:   { type: DataTypes.INTEGER,     allowNull: true },
  vendorName: { type: DataTypes.STRING(200), defaultValue: '' },
  projectAccountId: { type: DataTypes.INTEGER, allowNull: true },

  date:         { type: DataTypes.DATEONLY, allowNull: false },
  deliveryDate: { type: DataTypes.DATEONLY, allowNull: true },

  items: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() { try { return JSON.parse(this.getDataValue('items') || '[]'); } catch(e) { return []; } },
    set(v) { this.setDataValue('items', JSON.stringify(v || [])); },
  },

  totalAmount: { type: DataTypes.DECIMAL(14,2), defaultValue: 0 },

  status: {
    type: DataTypes.ENUM('Draft','Sent','Received','Closed','Cancelled'),
    defaultValue: 'Draft',
  },
  notes: { type: DataTypes.TEXT, defaultValue: '' },
  createdBy: { type: DataTypes.INTEGER, allowNull: true },
}, { timestamps: true });

module.exports = PurchaseOrder;
