const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const NotificationRead = sequelize.define('NotificationRead', {
  notificationId: { type: DataTypes.INTEGER, allowNull: false },
  userId:         { type: DataTypes.INTEGER, allowNull: false },
  readAt:         { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  timestamps: false,
  indexes: [{ unique: true, fields: ['notificationId', 'userId'] }],
});

module.exports = NotificationRead;
