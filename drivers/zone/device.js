'use strict';

const Homey = require('homey');
const axios = require('axios');

const F_TO_C = f => Math.round((f - 32) * 5 / 9 * 2) / 2; // round to 0.5°C steps
const C_TO_F = c => Math.round(c * 9 / 5 + 32);           // back to integer °F

const ZONE_MODE_MAP = {
  AUTO: 'auto',
  COOL: 'cool',
  HEAT: 'heat',
  OFF:  'off',
};
const HOMEY_MODE_MAP = {
  auto: 'AUTO',
  cool: 'COOL',
  heat: 'HEAT',
  off:  'OFF',
};


module.exports = class ZoneDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Trane Zone device has been initialized');
    const { zoneId, thermostatId } = this.getData();
    const { houseId } = this.getStore();
    this._zoneId      = zoneId;
    this._thermostatId = thermostatId;
    this._houseId     = houseId;
    this._etag        = null;
    this._lastHeatF = 32;
    this._lastCoolF = 32;
    this._registerCapabilityListeners();
    this._startPolling();
  }

  _getHeaders() {
    const key      = this.homey.settings.get('key');
    const mobileId = this.homey.settings.get('mobileId');
    return {
      'X-ApiKey':           key,
      'X-AppVersion':       '8.13.0',
      'X-AssociatedBrand':  'trane',
      'X-MobileId':         mobileId,
      'X-Requested-With':   'com.schlagelink.android',
    };
  }

  _registerCapabilityListeners() {
    this.registerCapabilityListener('target_temperature.heat', async (value) => {
      const heatF = C_TO_F(value);
      await this._setSetpoints(heatF, this._lastCoolF);
    });

    this.registerCapabilityListener('target_temperature.cool', async (value) => {
      const coolF = C_TO_F(value);
      await this._setSetpoints(this._lastHeatF, coolF);
    });

    this.registerCapabilityListener('thermostat_mode', async (value) => {
      await this._setZoneMode(HOMEY_MODE_MAP[value]);
    });
  }

    async _setSetpoints(heatF, coolF) {
    const delta = 3; // API enforced minimum gap
    if (coolF - heatF < delta) coolF = heatF + delta;

    await axios.post(
      `https://www.mynexia.com/mobile/xxl_zones/${this._zoneId}/run_mode`,
      { value: 'permanent_hold' },
      { headers: this._getHeaders() }
    );
    await axios.post(
      `https://www.mynexia.com/mobile/xxl_zones/${this._zoneId}/setpoints`,
      { heat: heatF, cool: coolF },
      { headers: this._getHeaders() }
    );
  }

  async _setZoneMode(nexiaMode) {
    await axios.post(
      `https://www.mynexia.com/mobile/xxl_zones/${this._zoneId}/zone_mode`,
      { value: nexiaMode },
      { headers: this._getHeaders() }
    );
  }

  _startPolling() {
    this._stopPolling();
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), 30000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      const headers = { ...this._getHeaders() };
      if (this._etag) headers['If-None-Match'] = this._etag;

      const response = await axios.get(
        `https://www.mynexia.com/mobile/houses/${this._houseId}`,
        {
          headers,
          validateStatus: s => s === 200 || s === 304,
        }
      );

      if (response.status === 304) return;

      if (response.headers.etag) this._etag = response.headers.etag;

      this._applyState(response.data.result);
    } catch (err) {
      this.error('Poll error:', err.message);
    }
  }

  _applyState(result) {
    const devicesLink = result._links.child.find(l => l.href.endsWith('/devices'));
    const thermostat  = devicesLink.data.items.find(t => t.id === this._thermostatId);
    if (!thermostat) return;

    let zone;

    if (this._zoneId) {
      const groupFeature = thermostat.features.find(f => f.name === 'group');
      if (!groupFeature) {
        this.error('Expected group feature not found on multi-zone thermostat');
        return;
      }
      zone = groupFeature.members.find(z => z.id === this._zoneId);
    } else {
      zone = (thermostat.zones && thermostat.zones[0]) || null;
    }

    if (!zone) return;

    this._lastHeatF = zone.heating_setpoint;
    this._lastCoolF = zone.cooling_setpoint;

    const mode     = ZONE_MODE_MAP[zone.current_zone_mode] ?? 'auto';
    const currentC = F_TO_C(zone.temperature);

    this.setCapabilityValue('measure_temperature', currentC).catch(this.error);
    this.setCapabilityValue('target_temperature.heat', F_TO_C(this._lastHeatF)).catch(this.error);
    this.setCapabilityValue('target_temperature.cool', F_TO_C(this._lastCoolF)).catch(this.error);
    this.setCapabilityValue('thermostat_mode', mode).catch(this.error);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Thermostat has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Thermostat settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('Thermostat was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Thermostat has been deleted');
    this._stopPolling();
  }

};
