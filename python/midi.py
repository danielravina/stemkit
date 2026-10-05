import argparse
import io
import json
import sys
from contextlib import redirect_stdout


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    emit(type="progress", stage="midi", pct=0, message="loading model")

    # basic-pitch prints unconditional debug lines (isfinite/shape/dtype,
    # "Predicting MIDI for...", progress banners) straight to stdout via
    # print(); redirect them away so only our JSON lines reach the parent
    try:
        with redirect_stdout(io.StringIO()):
            from basic_pitch.inference import predict
            from basic_pitch import ICASSP_2022_MODEL_PATH

            _, midi_data, note_events = predict(args.input, ICASSP_2022_MODEL_PATH)
    except Exception as e:
        fail(f"transcription failed: {e}")

    emit(type="progress", stage="midi", pct=90, message="writing midi")
    try:
        midi_data.write(args.out)
    except Exception as e:
        fail(f"could not write midi: {e}")

    emit(type="done", notes=len(note_events), out=args.out)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        fail(str(e)[:400])
