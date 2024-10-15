# Set the base image to denoland/deno
FROM denoland/deno:2.0.0

EXPOSE 8000
WORKDIR /app
USER deno

################## BEGIN INSTALLATION ######################

# Cache the dependencies
COPY deps.ts .
RUN deno cache deps.ts

# These steps will be re-run upon each file change in the working directory:
COPY . .

# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN deno cache app.ts

##################### INSTALLATION END #####################

# Set default command to run the API
CMD ["deno", "task", "start"]
