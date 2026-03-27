const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Notification = sequelize.define('Notification', {
  companyId: { type: DataTypes.INTEGER, allowNull: true },
  title: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, defaultValue: '' },
  type: { type: DataTypes.ENUM('info', 'warning', 'success', 'urgent'), defaultValue: 'info' },
  status: { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  // File attachment (optional — admin can upload file for employees to download)
  fileName: { type: DataTypes.STRING, defaultValue: '' },
  filePath: { type: DataTypes.STRING, defaultValue: '' },
  fileSize: { type: DataTypes.INTEGER, defaultValue: 0 },
  mimeType: { type: DataTypes.STRING, defaultValue: '' },
  createdBy: { type: DataTypes.INTEGER, allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
}, { timestamps: true });

module.exports = Notification;
