"""
VisionGuard - one-off dev utility, not part of the shipped application.

Fixes a cosmetic issue in the UltraFace ONNX model: its weight tensors
are listed as graph INPUTS (an artifact of how it was originally
exported), which stops ONNX Runtime from applying constant-folding
optimization and produces harmless warnings on every load. This
removes those weight tensors from the input list so they're treated
as true constants.

Usage: python remove_initializer_from_input.py version-slim-320.onnx version-slim-320-optimized.onnx
"""

import sys
import onnx


def main():
    if len(sys.argv) != 3:
        print("Usage: python remove_initializer_from_input.py <input.onnx> <output.onnx>")
        sys.exit(1)

    input_path, output_path = sys.argv[1], sys.argv[2]

    model = onnx.load(input_path)
    graph = model.graph

    initializer_names = {init.name for init in graph.initializer}

    # Keep only inputs that are NOT also initializers (i.e. real inputs, not weights)
    new_inputs = [inp for inp in graph.input if inp.name not in initializer_names]

    removed_count = len(graph.input) - len(new_inputs)

    del graph.input[:]
    graph.input.extend(new_inputs)

    onnx.save(model, output_path)
    print(f"Removed {removed_count} weight tensors from graph inputs.")
    print(f"Saved optimized model to: {output_path}")


if __name__ == "__main__":
    main()