"""Reproduce the frozen host packer's signed/unsigned comparison without GPU work.

The first overflow comparison in float_to_half_bits is against 0x1FU.
C++ therefore converts negative adjusted_exponent to uint32_t before comparing.
Python struct's IEEE binary16 encoder supplies an independent reference.
"""
from pathlib import Path
import math
import struct


def frozen_packer(value):
    bits = struct.unpack('<I', struct.pack('<f', value))[0]
    sign = (bits >> 16) & 0x8000
    exponent = (bits >> 23) & 0xff
    mantissa = bits & 0x7fffff
    if exponent == 0xff:
        return sign | (0x7c00 if mantissa == 0 else 0x7e00)
    adjusted_exponent = exponent - 127 + 15
    # Reproduce the usual arithmetic conversion in `adjusted_exponent >= 0x1FU`.
    if (adjusted_exponent & 0xffffffff) >= 0x1f:
        return sign | 0x7c00
    if adjusted_exponent <= 0:
        if adjusted_exponent < -10:
            return sign
        mantissa |= 0x800000
        half_mantissa = mantissa >> (1 - adjusted_exponent)
        if half_mantissa & 0x1000:
            half_mantissa += 0x2000
        return sign | (half_mantissa >> 13)
    if mantissa & 0x1000:
        mantissa += 0x2000
        if mantissa & 0x800000:
            mantissa = 0
            adjusted_exponent += 1
            if adjusted_exponent >= 0x1f:
                return sign | 0x7c00
    return sign | (adjusted_exponent << 10) | (mantissa >> 13)


lines = ['Input | Frozen host bits | IEEE binary16 reference bits | Decoded frozen value']
for value in (0.0, 2**-24, 2**-16, 2**-14, 0.5):
    frozen = frozen_packer(value)
    reference = struct.unpack('<H', struct.pack('<e', value))[0]
    decoded = struct.unpack('<e', struct.pack('<H', frozen))[0]
    lines.append(f'{value:.12g} | 0x{frozen:04x} | 0x{reference:04x} | {decoded}')
    if value in (0.0, 2**-24, 2**-16):
        assert math.isinf(decoded) and frozen != reference
    else:
        assert frozen == reference
text = '\n'.join(lines) + '\n'
print(text, end='')
Path(__file__).with_suffix('.txt').write_text(text, encoding='utf-8')
