# Ecoforest ecoGEO for Homebridge

Control your Ecoforest ecoGEO heat pump from **Apple Home**, and monitor temperatures,
heating demands and electricity consumption through [Homebridge](https://homebridge.io/).
The plugin connects to your heat pump's **local easyNet web interface**.
No Modbus adapter or additional wiring is required.

**This is an unofficial plugin, not affiliated with or supported by Ecoforest.**
It can change how your heat pump operates. Read the [safety notice](#safety-and-disclaimer)
before enabling controls.

## What you can do

- Enable or disable domestic hot water (DHW) and adjust its target temperature.
- Enable or disable heating without disabling DHW.
- Select Winter, Summer, Auto or Combined operation.
- View outdoor, DHW, heating buffer and production supply temperatures.
- Check production demands and the consumption demand of each configured circuit.
- Monitor electrical power, heating COP, circuit pressures and electricity consumed
  during the current day and month.
- See whether the heat pump reports an active alarm.

**Cooling and swimming pool controls and dedicated monitoring are not supported.**
Selecting Summer or Combined changes the heat pump's program, but does not add
cooling or pool features to the plugin.

## Before you start

You need:

- An Ecoforest ecoGEO with a working local easyNet web interface.
- A Homebridge installation that can reach easyNet on your local network.
- The easyNet URL and login credentials. Check that you can sign in through a browser first.
- The number of heating circuits installed on your system, such as G1 and G2.

The plugin has been tested with one installation using easyNet 2024 firmware,
Homebridge 2.4 and Node.js 24. Other firmware versions and equipment configurations
have not been verified and may use a different protocol.

Use a trusted local network. Do not expose easyNet directly to the internet.
HTTPS certificate verification is currently disabled to accept easyNet's self-signed
certificate; HTTP connections send Basic Auth credentials without encryption.

## Installation

### Using the Homebridge plugin manager

1. Open the Homebridge web interface and go to **Plugins**.
2. Search for `homebridge-ecoforest-ecogeo` and install the matching package.
   Check that its repository links to
   [mcalvete/homebridge-ecoforest-ecogeo](https://github.com/mcalvete/homebridge-ecoforest-ecogeo).
3. Open the plugin settings and enter your easyNet connection details and circuit count
   as described under [Configuration](#configuration).
4. Save the settings and restart Homebridge.

### Manual installation from npm

You can also install the plugin from a terminal on the machine running Homebridge:

```bash
npm install -g homebridge-ecoforest-ecogeo
```

Use the Node.js/npm environment used by your Homebridge installation. Add the
[configuration](#configuration) to Homebridge and restart it.

### Manual installation from source

To build and install the plugin directly from its source code, run these steps
on the machine running Homebridge:

1. Clone the project:

   ```bash
   git clone https://github.com/mcalvete/homebridge-ecoforest-ecogeo.git
   cd homebridge-ecoforest-ecogeo
   ```

2. Build and link the plugin:

   ```bash
   npm install
   npm run build
   npm link
   ```

3. Add the [configuration](#configuration) to Homebridge, then restart it.

Keep the source directory in place: `npm link` creates a link to it, not an independent
copy. The linked package must be accessible to the Node.js installation and account
used by Homebridge. Container and service installations may require their own
local-plugin installation procedure.

### Add the accessories to Apple Home

If your Homebridge bridge is already paired, the accessories should appear after
the restart. Otherwise, pair the bridge using Homebridge's QR code. If you run
the plugin as a child bridge, pair that child bridge using its own QR code.

## Configuration

Enter the settings in the Homebridge plugin configuration screen, or add this entry
to the `platforms` array in your Homebridge configuration:

```json
{
  "platform": "EcoforestEcoGeo",
  "name": "ecoGEO",
  "host": "https://YOUR_EASYNET_HOST",
  "username": "YOUR_SERIAL_NUMBER",
  "password": "YOUR_EASYNET_PASSWORD",
  "heatingCoolingGroupCount": 2,
  "pollInterval": 60,
  "powerSwitchMode": "confirm"
}
```

Replace the placeholders with your own connection details. Keep credentials private
when sharing configuration or asking for help.

| Setting | What to enter |
|---|---|
| `host` | Your heat pump's local easyNet URL, including `https://` or `http://`. Replace `YOUR_EASYNET_HOST` with its local hostname or IP address. |
| `username` | The username used to sign in to easyNet, normally the heat pump serial number. |
| `password` | Your easyNet password. On the tested installation, this is the first 8 characters of the original Wi-Fi password. |
| `heatingCoolingGroupCount` | Number of installed circuits G1..Gn. Default: `2`; allowed range: `0` to `5`. Each adds a demand sensor and a supply setpoint sensor. |
| `pollInterval` | Time between readings, in whole seconds. Default: `60`; allowed range: `15` to `3600`. |
| `powerSwitchMode` | Protection for the whole-machine power switch; see below. Default: `confirm`. |
| `debug` | Optional verbose logging for troubleshooting. Default: `false`. |

Configure only circuits that actually exist. The limit of five reflects the easyNet
data layout, not a guarantee that your model supports five physical circuits.

### Protecting the main power switch

The **Heat Pump** switch affects the whole machine, including DHW:

- **`confirm`**: turning it off requires two off commands within 10 seconds.
  After the first command, the switch returns to on; turn it off again to confirm.
- **`normal`**: each command switches the machine on or off immediately.
- **`readonly`**: displays the machine's state without allowing changes.

Use the **Heating** or **DHW** controls when you only want to disable that service,
rather than switching off the entire heat pump.

## Using Apple Home

Default accessory names follow the English easyNet interface. You can rename them
and assign rooms in Apple Home; custom names are preserved. Changing the easyNet
display language does not affect the plugin.

### DHW and heating

| Accessory | What it shows | What you can change |
|---|---|---|
| **DHW** | Actual tank temperature, target temperature and production state | Enable/disable DHW; set its target from 30 to 65 degrees Celsius |
| **Heating** | Actual heating buffer temperature, target temperature and production state | Enable/disable heating; DHW remains independently enabled |
| **Program** | Current program as a group of four switches | Select Winter, Summer, Auto or Combined |
| **Heat Pump** | Whole-machine on/off state | Turn the machine on/off, subject to `powerSwitchMode` |

The DHW and Heating accessories use HomeKit heater controls. Their heating state
comes from easyNet's reported operation mode, not from an estimate based on temperature.

The **Heating target is read-only**: it represents the heating buffer setpoint
calculated by the heat pump's heating curve, not a room thermostat setting.

**Program** is a single accessory containing mutually exclusive switches. Turn on
the program you want; turning off the selected option does not select another program.
Program selection is separate from the main power switch.

### Temperatures, demands and alarms

| Accessory | Meaning |
|---|---|
| **Outdoor Temperature** | Outdoor sensor reading |
| **Production Supply** | Measured production circuit supply temperature |
| **G1..Gn Setpoint Temperature** | Supply temperature requested for each circuit; this is a setpoint, not a measured circuit temperature |
| **Heating Production Demand / DHW Production Demand** | Whether heating or DHW is requesting production |
| **G1..Gn Consumption Demand** | Whether each circuit is requesting heating or cooling; this does not provide dedicated cooling control |
| **Heat Pump Alarm** | Whether easyNet reports an active alarm; check easyNet or the machine for details |

Demand and alarm accessories appear as **contact sensors**:
**open means active**, and **closed means inactive**. They are read-only.
A demand indicates a request, not necessarily that the compressor is running.

### Power, consumption, COP and pressures

Apple Home does not display the custom measurement characteristics used here.
To make these readings visible in Apple Home, the plugin also exposes them as
**light sensors**. The number is useful, but the displayed **lx unit is not the
physical unit**:

| Accessory | Actual meaning | Example in Apple Home |
|---|---|---|
| **Electric Power** | Instantaneous electrical power in watts | `1250 lx` means 1250 W |
| **Consumption Current Day** | Electricity consumed during the current day, in kWh | `3.8 lx` means 3.8 kWh |
| **Consumption Current Month** | Electricity consumed during the current month, in kWh | `80.6 lx` means 80.6 kWh |
| **COP** | Instantaneous heating power divided by electrical power | `4.2 lx` means a COP of 4.2 |
| **Production Pressure / Brine Pressure** | Circuit pressure in bar | `1.7 lx` means 1.7 bar |

Third-party HomeKit apps on iOS, such as [Eve for Matter & HomeKit](https://apps.apple.com/app/id917695792)
([app information](https://www.evehome.com/en/eve-app)), can access the additional
custom characteristics. Eve can show electrical power in **W**, consumption in
**kWh** and pressure in **hPa** (1000 hPa = 1 bar), instead of the light-sensor unit.

Consumption includes compressor/inverter energy, circulation pumps when configured
for inclusion by the heat pump, and auxiliary electric heaters.

Keep these display limitations in mind:

- A real zero is shown as `0.0001 lx`, the minimum light-sensor value.
- Light-sensor readings are capped at `100000 lx`.
- COP is reported as zero when electrical power is zero, rather than as unavailable.
  Apple Home displays this as `0.0001 lx`, like other zero readings.
- Missing sensors and failed readings are reported as unavailable rather than
  retaining valid-looking old values.

## Troubleshooting

| Problem | What to check |
|---|---|
| No accessories appear | Restart Homebridge, check that its bridge is paired with Apple Home, and inspect the Homebridge log for plugin loading or configuration errors. |
| Accessories show No Response | Check that easyNet is reachable from the Homebridge machine and that the URL and credentials work. The plugin retries readings and recovers when communication resumes. |
| Readings take time to update | Normal updates follow `pollInterval`. A control change schedules an earlier refresh, but device responses and retries can delay it. |
| The main power switch returns to on | This is expected in `confirm` mode after the first off command. Send a second off command within 10 seconds. |
| Heating cannot change its target temperature | The displayed target is the heat pump's calculated buffer setpoint and is intentionally read-only. |
| A circuit temperature looks different from a thermometer | G1..Gn sensors show requested supply setpoints, not actual measured temperatures. |
| COP reads zero while the machine is idle | This is expected when electrical power is zero; Apple Home displays `0.0001 lx`. |
| A value is displayed in lx | This is the Apple Home presentation workaround explained above; use a compatible app such as Eve for supported measurements in their actual units. |

For further diagnosis, temporarily enable `debug` in the plugin settings and check
the Homebridge log. Disable it afterwards, and remove private information before
sharing logs. For machine alarms or unexpected operation, consult easyNet and your
installer rather than relying solely on HomeKit.

## Safety and disclaimer

**Use this plugin at your own risk.** It can change heat pump settings and operation.
Follow the manufacturer's instructions and consult a qualified installer before
changing settings or creating automations that control the machine.

To the fullest extent permitted by applicable law, the author and contributors
accept no liability for faults, malfunctions, damage to the heat pump or connected
equipment, or any other loss arising from the use of this plugin.

This is an independent, unofficial project. It is not affiliated with, endorsed by,
sponsored by or supported by Ecoforest.

**Ecoforest** and **ecoGEO** are trademarks of their respective owners within the
Ecoforest group. These names are used solely to identify compatible equipment;
no ownership of these trademarks is claimed. Visit the [official Ecoforest website](https://ecoforest.com/en/)
for information about the brand and its ecoGEO heat pumps.

## License

Copyright (c) 2026 Martín Calvete Iglesias. Released under the [MIT License](./LICENSE).
This license covers the plugin code, not the Ecoforest or ecoGEO trademarks.

## Acknowledgements

The [Ecoforest ecoGEO integration for Home Assistant by bytestorm](https://github.com/bytestorm/ecoforest_ecogeo)
was consulted as a reference when researching communication with easyNet.
It is a separate project for Home Assistant, not a dependency of this Homebridge plugin.
