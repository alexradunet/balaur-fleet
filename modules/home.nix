# The admin's user environment (home-manager), the same on every machine.
#
# The `home` aspect puts home-manager into a host and gives the admin account
# (balaur.user) every shared `flake.modules.homeManager.*` aspect listed below.
# A host adds its own on top, in its host file:
#   home-manager.users.${config.balaur.user}.imports = [ aspects.homeManager.<name> ];
{ inputs, config, ... }:
let
  hm = config.flake.modules.homeManager;
in
{
  flake.modules.nixos.home =
    { config, ... }:
    {
      imports = [ inputs.home-manager.nixosModules.home-manager ];

      home-manager = {
        useGlobalPkgs = true; # our nixpkgs and its settings, no second copy
        useUserPackages = true; # packages land in /etc/profiles, next to the system's
        # A dotfile that was there before home-manager is kept as <name>.pre-balaur,
        # replacing an older backup: without that the activation aborts on it.
        backupFileExtension = "pre-balaur";
        overwriteBackup = true;

        users.${config.balaur.user} = {
          imports = with hm; [
            shell
            git
          ];
          home.stateVersion = "26.05"; # like system.stateVersion: the release this home started on
        };
      };
    };

  # A login shell that home-manager manages (it also sources the session variables).
  flake.modules.homeManager.shell = {
    programs.bash = {
      enable = true;
      historyControl = [
        "ignoredups"
        "erasedups"
      ];
      historySize = 10000;
    };
  };

  # Who commits, and GitHub over HTTPS through `gh` (`gh auth login` once per machine).
  # Every commit is signed with the admin's SSH key, the one the registry lists as
  # this machine's `userKeys`: auto-deploy switches only to a commit one of those
  # keys signed (auto-deploy.nix). `git log --show-signature` checks against the
  # same list (/etc/balaur/allowed-signers, written by the `fleet` aspect).
  flake.modules.homeManager.git = {
    programs.git = {
      enable = true;
      signing = {
        format = "ssh";
        key = "~/.ssh/id_ed25519.pub";
        signByDefault = true;
      };
      settings.gpg.ssh.allowedSignersFile = "/etc/balaur/allowed-signers";
      settings.user = {
        name = "alex";
        email = "radualexandrucosmin@gmail.com";
      };
    };
    programs.gh = {
      enable = true;
      gitCredentialHelper.enable = true;
    };
  };
}
