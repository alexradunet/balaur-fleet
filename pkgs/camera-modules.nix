# Patched kernel modules for the Yoga Duet 7 front camera (OVTI5678 sensor).
#
# The sensor is register-compatible with OV5675, but the firmware describes its
# power rails with INT3472 GPIO types Linux 6.18 does not know. This builds just
# the three affected modules out of the running kernel's own source and installs
# them under updates/, which depmod prefers over the stock in-tree copies.
#
# Called with `config.boot.kernelPackages.callPackage`, so `kernel` and
# `kernelModuleMakeFlags` are those of the selected kernel.
{
  lib,
  stdenv,
  kernel,
  kernelModuleMakeFlags,
}:

stdenv.mkDerivation {
  pname = "duet-camera-modules";
  version = kernel.version;

  src = kernel.src;
  # --fuzz=0: if a kernel bump moves the code, fail the build instead of
  # silently applying a hunk in the wrong place.
  patches = [ ./camera-yoga-duet-ov5678.patch ];
  patchFlags = [
    "-p1"
    "--fuzz=0"
  ];

  nativeBuildInputs = kernel.moduleBuildDependencies;
  hardeningDisable = [ "pic" ];
  enableParallelBuilding = true;

  postPatch = ''
        moduleDir="$PWD/duet-camera"
        mkdir -p "$moduleDir/include/linux/platform_data/x86"

        cp drivers/media/i2c/ov5675.c "$moduleDir/"
        cp drivers/media/pci/intel/ipu-bridge.c "$moduleDir/"
        cp drivers/platform/x86/intel/int3472/{discrete.c,discrete_quirks.c,clk_and_regulator.c,led.c} "$moduleDir/"
        cp include/linux/platform_data/x86/int3472.h "$moduleDir/include/linux/platform_data/x86/"

        cat > "$moduleDir/Makefile" <<'EOF2'
    obj-m += ipu-bridge.o
    obj-m += ov5675.o
    obj-m += intel_skl_int3472_discrete.o
    intel_skl_int3472_discrete-y := discrete.o discrete_quirks.o clk_and_regulator.o led.o

    # Force every INT3472 translation unit to use the patched structure layout and
    # supply-name limit before the stock kernel header can be included.
    ccflags-y += -include $(src)/include/linux/platform_data/x86/int3472.h
    EOF2
  '';

  buildPhase = ''
    runHook preBuild

    makeFlags=(
      ${lib.escapeShellArgs kernelModuleMakeFlags}
      "KERNELRELEASE=${kernel.modDirVersion}"
    )
    make -C "${kernel.dev}/lib/modules/${kernel.modDirVersion}/build" \
      "''${makeFlags[@]}" \
      M="$PWD/duet-camera" \
      modules

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    out_dir="$out/lib/modules/${kernel.modDirVersion}/updates/duet-camera"
    install -Dm444 duet-camera/ipu-bridge.ko "$out_dir/ipu-bridge.ko"
    install -Dm444 duet-camera/ov5675.ko "$out_dir/ov5675.ko"
    install -Dm444 duet-camera/intel_skl_int3472_discrete.ko \
      "$out_dir/intel_skl_int3472_discrete.ko"

    runHook postInstall
  '';

  meta = {
    description = "Patched Yoga Duet 7 OV5678 camera kernel modules";
    license = lib.licenses.gpl2Only;
    platforms = [ "x86_64-linux" ];
  };
}
