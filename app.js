'use strict';

const Homey = require('homey');

module.exports = class TraneApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Trane Home app has been initialized');
  }

};
