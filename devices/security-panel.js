import RingSocketDevice from './base-socket-device.js'
import { allAlarmStates, RingDeviceType } from 'ring-client-api'
import utils from '../lib/utils.js'
import state from '../lib/state.js'

export default class SecurityPanel extends RingSocketDevice {
    constructor(deviceInfo) {
        super(deviceInfo, 'alarm', 'alarmState')
        this.deviceData.mdl = 'Alarm Control Panel'
        this.deviceData.name = `${this.device.location.name} Alarm`

        this.data = {
            attributes: {
                initiatingEntityId: 'Unknown',
                initiatingEntityType: 'Unknown',
                initiatingUserName: 'Unknown'
            }
        }
        
        this.entity = {
            ...this.entity,
            alarm: {
                component: 'alarm_control_panel',
                attributes: true,
                isLegacyEntity: true  // Legacy compatibility
            },
            siren: {
                component: 'switch',
                icon: 'mdi:alarm-light',
                name: `${this.device.location.name} Siren`
            },
            ...utils.config().enable_panic ? {
                police: { 
                    component: 'switch',
                    name: `${this.device.location.name} Panic - Police`,
                    icon: 'mdi:police-badge'
                },
                fire: { 
                    component: 'switch',
                    name: `${this.device.location.name} Panic - Fire`,
                    icon: 'mdi:fire'
                }
            } : {}
        }

        // Listen to raw data updates for all devices and pick out
        // arm/disarm events for this security panel
        this.device.location.onDataUpdate.subscribe(async (message) => {
            if (message.datatype === 'DeviceInfoDocType' &&
                message.body?.[0]?.general?.v2?.zid === this.deviceId &&
                message.body[0].impulse?.v1?.[0] &&
                message.body[0].impulse.v1.filter(i => i.data?.commandType === 'security-panel.switch-mode').length > 0
            ) { 
                if (message.context) {
                    await this.updateAlarmAttributes(message.context)
                    this.pubishAlarmState()
                }
             }
        })
    }

    publishState(data) {
        const isPublish = data === undefined ? true : false

        if (isPublish) {
            // Eventually remove this but for now this attempts to delete the old light component based volume control from Home Assistant
            this.mqttPublish(`homeassistant/switch/${this.locationId}/${this.deviceId}_bypass/config`, '', false)
            this.pubishAlarmState()
        }

        const sirenState = (this.device.data.siren?.state === 'on') ? 'ON' : 'OFF'
        this.mqttPublish(this.entity.siren.state_topic, sirenState)

        if (utils.config().enable_panic) {
            const policeState = this.device.data.alarmInfo?.state?.match(/burglar|panic/) ? 'ON' : 'OFF'
            if (policeState === 'ON') { this.debug('Burgler alarm is triggered for '+this.device.location.name) }
            this.mqttPublish(this.entity.police.state_topic, policeState)

            const fireState = this.device.data.alarmInfo?.state?.match(/co|fire/) ? 'ON' : 'OFF'
            if (fireState === 'ON') { this.debug('Fire alarm is triggered for '+this.device.location.name) }
            this.mqttPublish(this.entity.fire.state_topic, fireState)
        }
    }

    async pubishAlarmState() {
        let alarmMode
        const alarmInfo = this.device.data.alarmInfo ? this.device.data.alarmInfo : []

        // If alarm is active report triggered or, if entry-delay, pending
        if (allAlarmStates.includes(alarmInfo.state))  {
            alarmMode = alarmInfo.state === 'entry-delay' ? 'pending' : 'triggered'
        } else {
            switch(this.device.data.mode) {
                case 'none':
                    alarmMode = 'disarmed'
                    break;
                case 'some':
                    alarmMode = 'armed_home'
                    break;
                case 'all':
                    const exitDelayMs = this.device.data.transitionDelayEndTimestamp - Date.now()
                    if (exitDelayMs > 0) {
                        alarmMode = 'arming'
                        this.waitForExitDelay(exitDelayMs)
                    } else {
                        alarmMode = 'armed_away'
                    }
                    break;
                default:
                    alarmMode = 'unknown'
            }
        }

        this.mqttPublish(this.entity.alarm.state_topic, alarmMode)
        this.mqttPublish(this.entity.alarm.json_attributes_topic, JSON.stringify(this.data.attributes), 'attr')
        this.publishAttributes()
    }

    async updateAlarmAttributes(contextData) {
        this.data.attributes = {
            initiatingEntityId: contextData.initiatingEntityId,
            initiatingEntityType: contextData.initiatingEntityType
        }

        if (contextData.initiatingEntityId) {
            try {
                const response = await this.device.location.restClient.request({
                    url: `https://app.ring.com/api/v1/rs/users/summaries?locationId=${this.locationId}`,
                    method: 'POST',
                    json: [contextData.initiatingEntityId]
                })

                if (Array.isArray(response) && response.length > 0) {
                    this.data.attributes.initiatingUserName = `${response[0].firstName} ${response[0].lastName}`
                    this.data.attributes.initiatingUserEmail = `${response[0].email}`
                }
            } catch (err) {
                this.debug(err)
                this.debug('Could not get user information from Ring API')
                this.data.attributes.initiatingUserName = 'Unknown'
                this.data.attributes.initiatingUserEmail = 'Unknown'
            }
        }
    }
    
    async waitForExitDelay(exitDelayMs) {
        await utils.msleep(exitDelayMs)
        if (this.device.data.mode === 'all') {
            exitDelayMs = this.device.data.transitionDelayEndTimestamp - Date.now()
            if (exitDelayMs <= 0) {
                // Publish device sensor state
                this.mqttPublish(this.entity.alarm.state_topic, 'armed_away')
            }
        }
    }

    // Process messages from MQTT command topic
    processCommand(command, message) {
        const entityKey = command.split('/')[0]
        switch (command) {
            case 'alarm/command':
                this.setAlarmMode(message)
                break;
            case 'siren/command':
                this.setSirenMode(message)
                break;
            case 'police/command':
                if (this.entity.hasOwnProperty(entityKey)) {
                    this.setPoliceMode(message)
                }
                break;
            case 'fire/command':
                if (this.entity.hasOwnProperty(entityKey)) {
                    this.setFireMode(message)
                }
                break;
            default:
                this.debug(`Received message to unknown command topic: ${command}`)
        }
    }

    // Set Alarm Mode on received MQTT command message
    async setAlarmMode(message) {
        this.debug(`Received set alarm mode ${message} for location ${this.device.location.name} (${this.locationId})`)

        // Try to set alarm mode and retry after delay if mode set fails
        // Performing initial arming attempt with no delay
        let retries = 5
        let setAlarmSuccess = false
        while (retries-- > 0 && !(setAlarmSuccess)) {
            const bypassDeviceIds = []

            if (message.toLowerCase() !== 'disarm') {
                // During arming, check for sensors that require bypass
                // Get all devices that allow bypass 
                const bypassDevices = (await this.device.location.getDevices()).filter(device => 
                    device.deviceType === RingDeviceType.ContactSensor ||
                    device.deviceType === RingDeviceType.RetrofitZone ||
                    device.deviceType === RingDeviceType.MotionSensor ||
                    device.deviceType === RingDeviceType.TiltSensor ||
                    device.deviceType === RingDeviceType.GlassbreakSensor
                ),
                savedStates = state.getAllSavedStates(),
                bypassDeviceNames = []

                // Loop through all bypass eligible devices and bypass based on settings/state
                for (const device of bypassDevices) {
                    const bypassMode = savedStates[device.id]?.bypass_mode
                    if (bypassMode === 'Always' || (bypassMode === 'Faulted' && device.data.faulted)) {
                        bypassDeviceIds.push(device.id)
                        bypassDeviceNames.push(`${device.name} [${bypassMode}]`)
                    }
                }

                if (bypassDeviceIds.length > 0) {
                    this.debug(`The following sensors will be bypassed [Reason]: ${bypassDeviceNames.join(', ')}`)
                } else {
                    this.debug('No sensors will be bypased')
                }
            }

            setAlarmSuccess = await this.trySetAlarmMode(message, bypassDeviceIds)

            // On failure delay 10 seconds for next set attempt
            if (!setAlarmSuccess) { await utils.sleep(10) }
        }

        // Check the return status and print some debugging for failed states
        if (!setAlarmSuccess) {
            this.debug('Alarm could not enter proper arming mode after all retries...Giving up!')
        } else if (setAlarmSuccess == 'unknown') {
            this.debug('Unknown alarm arming mode requested.')
        }
    }

    async trySetAlarmMode(message, bypassDeviceIds) {
        let alarmTargetMode
        this.debug(`Set alarm mode: ${message}`)
        switch(message.toLowerCase()) {
            case 'disarm':
                this.device.location.disarm().catch(err => { this.debug(err) })
                alarmTargetMode = 'none'
                break
            case 'arm_home':
                this.device.location.armHome(bypassDeviceIds).catch(err => { this.debug(err) })
                alarmTargetMode = 'some'
                break
            case 'arm_away':
                this.device.location.armAway(bypassDeviceIds).catch(err => { this.debug(err) })
                alarmTargetMode = 'all'
                break
            default:
                this.debug('Cannot set alarm mode: Unknown')
                return 'unknown'
        }

        // Sleep a few seconds and check if alarm entered requested mode
        await utils.sleep(1);
        if (this.device.data.mode == alarmTargetMode) {
            this.debug(`Alarm for location ${this.device.location.name} successfully entered ${message} mode`)
            return true
        } else {
            this.debug(`Alarm for location ${this.device.location.name} failed to enter requested arm/disarm mode!`)
            return false
        }
    }

    async setSirenMode(message) {
        switch(message.toLowerCase()) {
            case 'on':
                this.debug(`Activating siren for ${this.device.location.name}`)
                this.device.location.soundSiren().catch(err => { this.debug(err) })
                break;
            case 'off': {
                this.debug(`Deactivating siren for ${this.device.location.name}`)
                this.device.location.silenceSiren().catch(err => { this.debug(err) })
                break;
            }
            default:
                this.debug('Received invalid command for siren!')
        }
    }

    async setPoliceMode(message) {
        switch(message.toLowerCase()) {
            case 'on':
                this.debug(`Activating burglar alarm for ${this.device.location.name}`)
                this.device.location.triggerBurglarAlarm().catch(err => { this.debug(err) })
                break;
            case 'off': {
                this.debug(`Deactivating burglar alarm for ${this.device.location.name}`)
                this.device.location.setAlarmMode('none').catch(err => { this.debug(err) })
                break;
            }
            default:
                this.debug('Received invalid command for panic!')
        }
    }

    async setFireMode(message) {
        switch(message.toLowerCase()) {
            case 'on':
                this.debug(`Activating fire alarm for ${this.device.location.name}`)
                this.device.location.triggerFireAlarm().catch(err => { this.debug(err) })
                break;
            case 'off': {
                this.debug(`Deactivating fire alarm for ${this.device.location.name}`)
                this.device.location.setAlarmMode('none').catch(err => { this.debug(err) })
                break;
            }
            default:
                this.debug('Received invalid command for panic!')
        }
    }
}
