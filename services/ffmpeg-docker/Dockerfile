FROM jrottenberg/ffmpeg:5-ubuntu
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu-core \
    fonts-liberation \
    fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["ffmpeg"]
