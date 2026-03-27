const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RecycleBin = sequelize.define('RecycleBin', {
  // What was deleted
  itemType: { type: DataTypes.ENUM('user', 'leave', 'timesheet', 'salary', 'document', 'notification', 'company'), allowNull: false },
  itemId: { type: DataTypes.INTEGER, allowNull: false },
  itemData: { type: DataTypes.JSON, allowNull: false }, // full snapshot of the deleted record
  itemTitle: { type: DataTypes.STRING, defaultValue: '' }, // human-readable label
  // Who deleted it
  deletedBy: { type: DataTypes.INTEGER, allowNull: true },
  deletedByName: { type: DataTypes.STRING, defaultValue: '' },
  companyId: { type: DataTypes.INTEGER, allowNull: true },
  // Auto-purge after 30 days
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: () => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      return d;
    },
  },
}, { timestamps: true });

module.exports = RecycleBin;
