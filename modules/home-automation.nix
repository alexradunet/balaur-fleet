# Home automation: Home Assistant + a loopback-only MQTT broker (+ optional Zigbee2MQTT).
{ config, lib, ... }:
let
  cfg = config.duet;
  ha = cfg.homeAutomation;
in
lib.mkIf ha.enable {
  services.home-assistant = {
    enable = true;
    openFirewall = true;
    extraComponents = [
      "default_config"
      "met"
      "mqtt"
      "esphome"
      "cast"
      "homekit_controller"
      "radio_browser"
    ];
    config = {
      default_config = { };
      homeassistant = {
        name = "Home";
        unit_system = "metric";
        time_zone = config.time.timeZone;
      };
      http.server_host = "0.0.0.0";
      # Keep UI-created automations/scenes working alongside declarative config.
      "automation ui" = "!include automations.yaml";
      "scene ui" = "!include scenes.yaml";
    };
  };
  systemd.tmpfiles.rules = [
    "f /var/lib/hass/automations.yaml 0644 hass hass - []"
    "f /var/lib/hass/scenes.yaml      0644 hass hass - []"
  ];

  # MQTT stays on loopback: Home Assistant and Zigbee2MQTT run on this host.
  services.mosquitto = {
    enable = true;
    listeners = [
      {
        address = "127.0.0.1";
        port = 1883;
        omitPasswordAuth = true;
        settings.allow_anonymous = true;
        acl = [ "topic readwrite #" ];
      }
    ];
  };

  services.zigbee2mqtt = lib.mkIf ha.zigbee.enable {
    enable = true;
    settings = {
      homeassistant.enabled = true;
      permit_join = false;
      mqtt.server = "mqtt://127.0.0.1:1883";
      serial.port = ha.zigbee.serialPort;
      frontend = {
        host = "0.0.0.0";
        port = 8081;
      };
    };
  };
  networking.firewall.allowedTCPPorts = lib.mkIf ha.zigbee.enable [ 8081 ];

  duet.dashboard.services = [
    {
      name = "Home Assistant";
      description = "Devices & automations";
      icon = "🏠";
      port = 8123;
      unit = "home-assistant.service";
      group = "Home";
    }
    {
      name = "MQTT";
      description = "Message broker (local only)";
      icon = "📡";
      unit = "mosquitto.service";
      group = "Home";
    }
  ] ++ lib.optional ha.zigbee.enable {
    name = "Zigbee2MQTT";
    description = "Zigbee devices";
    icon = "🐝";
    port = 8081;
    unit = "zigbee2mqtt.service";
    group = "Home";
  };
}
