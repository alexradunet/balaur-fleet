# The machine's GNOME desktop over RDP, with no monitor and no auto-login: GNOME
# Remote Desktop's "remote login" (the system daemon). Connecting gives GDM's login
# screen, and each connection its own session. GNOME 49 and later are Wayland only,
# so this is GNOME's way; xrdp and X2Go need an X11 desktop.
#
# Two logins: first the RDP one (the admin's name, the `rdp-password` entry of this
# machine's sops file), then the account's own at the login screen.
#
#   the fleet:        `remote-desktop-client` (below): an app per host, one click
#   Windows:          Remote Desktop Connection, to `server` (the tailnet name)
#   Android, iOS:     Microsoft's "Windows App"
#   the password:     sops decrypt --extract '["rdp-password"]' secrets/hosts/server.yaml
#
# Port 3389 on the tailnet only (tailscale0 is trusted; nothing is opened on the
# LAN). The TLS certificate is self-signed, made once; a client asks to trust it
# the first time.
#
# Declared here: the daemon's settings, in /etc/gnome-remote-desktop/grd.conf, and
# its login, set again at every start from sops (it keeps its own copy; without a
# TPM it can use, in a file in its home), so sops stays the one place to change it.
#
# remote-desktop-client: on a desktop, an app ("server (Remote Desktop)") for every
# machine of the fleet with `remote-desktop`, which opens its desktop in a window
# (FreeRDP, resized with the window). The first click asks for that machine's RDP
# password and keeps it in the GNOME Keyring; every later click just connects. The
# client machine needs no secret of the server's: the laptop, which travels, is not
# a recipient of the other machines' sops files. A wrong or changed password:
# `balaur-rdp --forget <host>`, and the next click asks again. To copy it over
# without typing it: `ssh server "sops decrypt --extract '[\"rdp-password\"]' \
#   ~/Projects/balaur-fleet/secrets/hosts/server.yaml" | balaur-rdp --store server`.
{ config, ... }:
let
  nixosConfigs = config.flake.nixosConfigurations;
  fleet = config.fleet;
in
{
  flake.modules.nixos.remote-desktop =
    {
      config,
      lib,
      pkgs,
      options,
      ...
    }:
    let
      useSops = options ? sops;
      user = config.balaur.user;
      home = "/var/lib/gnome-remote-desktop";
      tls = "${home}/tls";
      grd = pkgs.gnome-remote-desktop;
      passwordFile =
        if useSops then config.sops.secrets.rdp-password.path else "/var/lib/secrets/rdp-password";

      setup = pkgs.writeShellApplication {
        name = "remote-desktop-setup";
        runtimeInputs = [
          grd
          pkgs.openssl
          pkgs.coreutils
          pkgs.util-linux
        ];
        text = ''
          if [ ! -s ${tls}/rdp.key ]; then
            install -d -m 0700 -o gnome-remote-desktop -g gnome-remote-desktop ${tls}
            openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
              -subj "/CN=${config.networking.hostName}" \
              -keyout ${tls}/rdp.key -out ${tls}/rdp.crt 2>/dev/null
            chown gnome-remote-desktop:gnome-remote-desktop ${tls}/rdp.key ${tls}/rdp.crt
            echo "made a TLS certificate"
          fi
          # `grdctl --system` is this same command run as the daemon's user through
          # pkexec, which NixOS does not have; root does it with runuser. On stdin,
          # so the password is never in a process list.
          runuser -u gnome-remote-desktop -- env HOME=${home} \
            XDG_DATA_HOME=${home}/.local/share XDG_CONFIG_HOME=${home}/.config \
            grdctl rdp set-credentials ${user} <${passwordFile}
          echo "RDP login set for ${user}"
        '';
      };
    in
    {
      options.balaur.remote-desktop.port = lib.mkOption {
        type = lib.types.port;
        default = 3389;
        description = "The RDP port, on the tailnet.";
      };

      config = lib.mkMerge [
        {
          services.gnome.gnome-remote-desktop.enable = true;

          environment.etc."gnome-remote-desktop/grd.conf".text = ''
            [RDP]
            enabled=true
            port=${toString config.balaur.remote-desktop.port}
            tls-cert=${tls}/rdp.crt
            tls-key=${tls}/rdp.key
          '';

          # The package's unit is installed but not enabled (upstream enables it
          # with grdctl, which writes /etc).
          systemd.services.gnome-remote-desktop = {
            wantedBy = [ "graphical.target" ];
            requires = [ "remote-desktop-setup.service" ];
            after = [ "remote-desktop-setup.service" ];
            restartTriggers = [ config.environment.etc."gnome-remote-desktop/grd.conf".source ];
          };

          systemd.services.remote-desktop-setup = {
            description = "GNOME Remote Desktop: TLS certificate and login";
            after = [ "dbus.service" ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
              ExecStart = lib.getExe setup;
            };
          };
        }
        # The password from this machine's sops file; changing it there restarts both.
        (lib.optionalAttrs useSops {
          sops.secrets.rdp-password = {
            sopsFile = config.balaur.secrets.hostFile;
            restartUnits = [
              "remote-desktop-setup.service"
              "gnome-remote-desktop.service"
            ];
          };
        })
      ];
    };

  flake.modules.nixos.remote-desktop-client =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      me = config.networking.hostName;
      hosts = lib.filter (
        h: h != me && nixosConfigs ? ${h} && nixosConfigs.${h}.config.balaur ? remote-desktop
      ) (lib.attrNames fleet);
      # host -> "<address>:<port> <user>", for the script.
      target =
        h:
        let
          c = nixosConfigs.${h}.config;
        in
        "${fleet.${h}.address}:${toString c.balaur.remote-desktop.port} ${c.balaur.user}";

      rdp = pkgs.writeShellApplication {
        name = "balaur-rdp";
        runtimeInputs = [
          pkgs.freerdp
          pkgs.libsecret
          pkgs.zenity
        ];
        text = ''
          forget=0
          store=0
          case ''${1:-} in
          --forget)
            forget=1
            shift
            ;;
          --store)
            store=1
            shift
            ;;
          esac
          host=''${1:?usage: balaur-rdp [--forget | --store] <host>  (--store reads the password on stdin)}
          case $host in
          ${lib.concatMapStrings (h: ''
            ${h}) read -r addr user <<<"${target h}" ;;
          '') hosts}
          *)
            echo "no machine with remote-desktop called $host" >&2
            exit 1
            ;;
          esac

          if [ "$forget" = 1 ]; then
            secret-tool clear service balaur-rdp host "$host"
            echo "forgot the RDP password for $host"
            exit 0
          fi
          if [ "$store" = 1 ]; then
            secret-tool store --label="Remote Desktop: $host" service balaur-rdp host "$host"
            echo "saved the RDP password for $host"
            exit 0
          fi

          while true; do
            password=$(secret-tool lookup service balaur-rdp host "$host" || true)
            if [ -z "$password" ]; then
              password=$(zenity --password --title="Remote Desktop: $host") || exit 0
              [ -n "$password" ] || exit 0
              printf '%s' "$password" |
                secret-tool store --label="Remote Desktop: $host" service balaur-rdp host "$host"
            fi

            # The password on stdin, never in the process list. tofu: the server's
            # self-signed certificate is trusted the first time and checked after.
            status=0
            printf '%s\n' "$password" | sdl-freerdp /v:"$addr" /u:"$user" /d: /from-stdin:force \
              /cert:tofu +dynamic-resolution /sound /gfx /title:"$host" /wm-class:balaur-rdp-"$host" \
              +auto-reconnect || status=$?

            # sdl-freerdp's exit codes (client/SDL/SDL3/sdl_utils.hpp): below 128 the
            # session ended (closed, logged off, disconnected); 132 and 134 are a
            # refused login; the rest of 128-254, a connection that failed.
            case $status in
            132 | 134)
              secret-tool clear service balaur-rdp host "$host"
              zenity --question --title="Remote Desktop: $host" \
                --text="$host refused the RDP password. Try another?" || exit 0
              ;;
            12[89] | 1[3-9][0-9] | 2[0-4][0-9] | 25[0-4])
              zenity --error --title="Remote Desktop: $host" \
                --text="Could not connect to $host (FreeRDP exit code $status). Is it on, and on the tailnet?"
              exit "$status"
              ;;
            *) exit 0 ;;
            esac
          done
        '';
      };
    in
    {
      environment.systemPackages = [
        rdp
      ]
      ++ map (
        h:
        pkgs.makeDesktopItem {
          name = "balaur-rdp-${h}";
          desktopName = "${h} (Remote Desktop)";
          comment = "${h}'s desktop in a window, over the tailnet";
          exec = "balaur-rdp ${h}";
          icon = "org.gnome.Settings-remote-desktop-symbolic";
          categories = [
            "Network"
            "RemoteAccess"
          ];
          startupWMClass = "balaur-rdp-${h}";
        }
      ) hosts;
    };
}
