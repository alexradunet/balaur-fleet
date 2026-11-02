# Baseline: boot, users, SSH, Nix, housekeeping.
{ config, lib, pkgs, ... }:
let
  cfg = config.duet;
in
{
  boot.loader.systemd-boot = {
    enable = true;
    configurationLimit = 10;
  };
  boot.loader.efi.canTouchEfiVariables = true;

  # Quiet boot: the built-in screen is an appliance display, not a console.
  boot.plymouth.enable = true;
  boot.consoleLogLevel = 0;
  boot.initrd.verbose = false;
  boot.kernelParams = [ "quiet" "loglevel=3" "udev.log_level=3" ];

  zramSwap.enable = true;
  services.fstrim.enable = true;
  services.journald.extraConfig = "SystemMaxUse=500M";

  users.mutableUsers = true;
  users.users.${cfg.user} = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "media" ];
    openssh.authorizedKeys.keys = cfg.sshKeys;
  };
  users.groups.media = { };

  services.openssh = {
    enable = true;
    # Port 22 is open on tailscale0 (trusted interface) always, and on the
    # LAN too while duet.ssh.lan is true (the default).
    openFirewall = cfg.ssh.lan;
    settings = {
      PasswordAuthentication = cfg.ssh.passwordAuth;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  warnings = lib.optional (cfg.sshKeys == [ ] && !cfg.ssh.passwordAuth && !cfg.network.enable)
    "SSH password login is off, no sshKeys are set and Tailscale is disabled: remote login is impossible.";

  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    trusted-users = [ "root" "@wheel" ];
    auto-optimise-store = true;
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  environment.systemPackages = with pkgs; [
    git
    vim
    htop
    btop
    ncdu
    jq
    curl
    smartmontools
    pciutils
    usbutils
  ];

  system.stateVersion = lib.mkDefault "26.05"; # match what your first install used
}
