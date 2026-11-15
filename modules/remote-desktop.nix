# The machine's GNOME desktop over RDP, with no monitor and no auto-login: GNOME
# Remote Desktop's "remote login" (the system daemon). Connecting gives GDM's login
# screen, and each connection its own session. GNOME 49 and later are Wayland only,
# so this is GNOME's way; xrdp and X2Go need an X11 desktop.
#
# Two logins: first the RDP one (the admin's name, the `rdp-password` entry of this
# machine's sops file), then the account's own at the login screen.
#
#   Windows:          Remote Desktop Connection, to `pc` (the tailnet name)
#   Android, iOS:     Microsoft's "Windows App"
#   Linux:            GNOME Connections or Remmina
#   the password:     sops decrypt --extract '["rdp-password"]' secrets/hosts/pc.yaml
#
# Port 3389 on the tailnet only (tailscale0 is trusted; nothing is opened on the
# LAN). The TLS certificate is self-signed, made once; a client asks to trust it
# the first time.
#
# Declared here: the daemon's settings, in /etc/gnome-remote-desktop/grd.conf, and
# its login, set again at every start from sops (it keeps its own copy; without a
# TPM it can use, in a file in its home), so sops stays the one place to change it.
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
      config = lib.mkMerge [
        {
          services.gnome.gnome-remote-desktop.enable = true;

          environment.etc."gnome-remote-desktop/grd.conf".text = ''
            [RDP]
            enabled=true
            port=3389
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
}
