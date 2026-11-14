"""Probe the first four macOS camera indices and save any frames found."""

import cv2


for index in range(4):
    camera = cv2.VideoCapture(index)
    ok, frame = camera.read()
    camera.release()
    if ok:
        filename = f"frame_{index}.jpg"
        cv2.imwrite(filename, frame)
        print(f"camera {index}: OK {frame.shape[1]}x{frame.shape[0]} -> {filename}")
    else:
        print(f"camera {index}: nothing")
