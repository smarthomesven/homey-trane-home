'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const axios = require('axios');

module.exports = class ThermostatDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Thermostat driver has been initialized');
  }

  async onPair(session) {
    this.log('Thermostat pairing started');
    session.setHandler("showView", async (viewId) => {
      this.log(`Showing view: ${viewId}`);
      if (viewId === "login") {
        const loggedIn = this.homey.settings.get('loggedIn');
        if (loggedIn) {
          this.log('User already logged in, skipping login view');
          await session.showView('list_devices');
          return;
        }
      }
      return;
    });
    session.setHandler("login", async (data) => {
      try {
        const username = data.email;
        const password = data.password;
        if (!data.email || !data.password) {
          return false;
        }
        const deviceUuid = crypto.randomUUID();
        const response = await axios.post('https://www.mynexia.com/mobile/accounts/sign_in',  {
          device_name: "samsung SM-A515F",
          device_uuid: deviceUuid,
          app_version: "8.13.0",
          is_commercial: false,
          login: username,
          password: password,
        });
        this.log("Login response",response.data);
        const key = response.data.result.api_key;
        const mobileId = response.data.result.mobile_id;
        if (response.data.success !== true) return false;
        this.homey.settings.set('username', username);
        this.homey.settings.set('password', password);
        this.homey.settings.set('deviceUuid', deviceUuid);
        this.homey.settings.set('key', key);
        this.homey.settings.set('mobileId', mobileId);
        const sessionresponse = await axios.post('https://www.mynexia.com/mobile/session',  {
          app_identifier: "com.schlagelink.android",
          app_version: "8.13.0",
          platform: "android"
        }, {
          headers: {
            'x-apikey': `${response.data.result.api_key}`,
            'x-appcode': 'nereus',
            'x-appversion': '8.13.0',
            'x-associatedbrand': 'trane',
            'x-mobileid': `${mobileId}`,
          }
        });
        this.log("Session response",sessionresponse.data);
        const houseId = sessionresponse.data.result._links.child[0].data.id;
        const houseResponse = await axios.get(`https://www.mynexia.com/mobile/houses/${houseId}`, {
          headers: {
            'X-ApiKey': `${key}`,
            'X-AppVersion': '8.13.0',
            'X-AssociatedBrand': 'trane',
            'X-MobileId': `${mobileId}`,
            'X-Requested-With': 'com.schlagelink.android',
          }
        });
        this.log("House response",houseResponse.data);
        this.homey.settings.set('loggedIn', true);
        await session.showView('list_devices');
        return true;
      } catch (error) {
        this.error("Login error", error.message);
        this.error("Login error stack", error.stack);
        if (error.response && error.response.status === 401) {
          return false;
        }
        return false;
      }
    });
    session.setHandler("list_devices", async () => {
      return await this.onPairListDevices();
    });
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    const loggedIn = this.homey.settings.get('loggedIn');
    if (!loggedIn) {
      this.error('User is not logged in, cannot list devices');
      return [];
    }

    const key = this.homey.settings.get('key');
    const mobileId = this.homey.settings.get('mobileId');
    this.log('requesting session response');

    const sessionResponse = await axios.post('https://www.mynexia.com/mobile/session', {
      app_identifier: 'com.schlagelink.android',
      app_version: '8.13.0',
      platform: 'android',
    }, {
      headers: {
        'x-apikey': key,
        'x-appcode': 'nereus',
        'x-appversion': '8.13.0',
        'x-associatedbrand': 'trane',
        'x-mobileid': mobileId,
      },
    });

    const devices = [];
    const houseLinks = sessionResponse.data.result._links.child.filter(link => {
      if (!link.href) return false;
      const prefix = 'https://www.mynexia.com/mobile/houses/';
      if (!link.href.startsWith(prefix)) return false;
      const rest = link.href.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    });

    for (const houseLink of houseLinks) {
      const houseId = houseLink.data.id;

      this.log(`Requesting devices for house ${houseId}`);
      const houseResponse = await axios.get(`https://www.mynexia.com/mobile/houses/${houseId}`, {
        headers: {
          'X-ApiKey': key,
          'X-AppVersion': '8.13.0',
          'X-AssociatedBrand': 'trane',
          'X-MobileId': mobileId,
          'X-Requested-With': 'com.schlagelink.android',
        },
      });

      const result = houseResponse.data.result;
      const devicesCollection = result._links.child.find(
        link => link.type === 'application/vnd.nexia.collection+json'
          && link.href.endsWith('/devices')
      );
      if (!devicesCollection) continue;

      for (const thermostat of devicesCollection.data.items) {
        const groupFeature = thermostat.features.find(f => f.name === 'group');
        if (groupFeature) {
          for (const zone of groupFeature.members) {
            devices.push({
              name: `${thermostat.name} – ${zone.name}`,
              data: {
                id: `${thermostat.id}_${zone.id}`, // unique per zone
                zoneId: zone.id,
                thermostatId: thermostat.id,
              },
              store: {
                houseId,
                thermostatType: thermostat.type,
              },
            });
          }
        } else {
          devices.push({
            name: thermostat.name,
            data: {
              id: String(thermostat.id),
              zoneId: null,
              thermostatId: thermostat.id,
            },
            store: {
              houseId,
              thermostatType: thermostat.type,
            },
          });
        }
      }
    }

    return devices;
  }

};
