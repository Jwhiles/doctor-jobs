import type { Prisma, PrismaClient } from "@prisma/client";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import * as O from "fp-ts/Option";
import { pipe, flow } from "fp-ts/lib/function";
import type { Console } from "node:console";

export type TransactionClient = Prisma.TransactionClient;

/**
 * DoctorJobs lets you queue jobs as part of Prisma transactions. This helps you avoid two failure modes
 * 1. The data is created, but a necessary job (eg, sending a confirmation email) is not queued.
 * 2. The data fails to be created, but a job that would refer to that data is created anyway.
 *
 * Using DoctorJobs means that if the data exists, then so will the job - and vice versa
 *
 *
 * @template Jobs - The type of job to be processed.
 * @template Input - The type of data to be input to the job processing function.
 * @template DeadLetters - The type of dead letter to be created in case of job processing failure.
 */
export class DoctorJobs<
  Jobs,
  Input extends { id: string; data: string },
  DeadLetters
> {
  /**
   * @type {PrismaClient}
   */
  client: PrismaClient;

  /**
   * A function for parsing input data into job data.
   *
   * @type {(input: Input) => E.Either<Error, Jobs>}
   */
  parseJob: (input: Input) => E.Either<Error, Jobs>;

  /**
   * A function for getting the next job from the queue.
   *
   * @type {() => Promise<Input>}
   */
  getJob: () => Promise<O.Option<Input>>;

  /**
   * A function for creating a new job in the queue.
   *
   * @type {(client: TransactionClient, data: string) => Promise<any>}
   */
  createJob: (client: TransactionClient, data: string) => Promise<any>;

  /**
   * A function for creating a new dead letter in case of job processing failure.
   *
   * @type {(input: DeadLetters) => Promise<void>}
   */
  createDeadLetter: (input: DeadLetters) => Promise<void>;

  /**
   * A function for getting all dead letters.
   *
   * @type {() => Promise<DeadLetters[]>}
   */
  getDeadLetters: () => Promise<DeadLetters[]>;

  /**
   * A logger for logging information about job processing.
   *
   * @type {Console}
   */

  log: any;

  /**
   * Creates a new `DoctorJobs` instance.
   *
   * @param {{
   *   prismaClient: PrismaClient;
   *   parseJob: (input: Input) => E.Either<Error, Jobs>;
   *   getJob: (client: PrismaClient) => Promise<O.Option<Input>>;
   *   createJob: (client: TransactionClient, data: string) => Promise<void>;
   *   createDeadLetter: (client: PrismaClient, input: DeadLetters) => Promise<void>;
   *   getDeadLetters: (client: PrismaClient) => Promise<DeadLetters[]>;
   *   logger?: Console;
   * }} options - An object containing options for configuring the `DoctorJobs` instance.
   */
  constructor({
    prismaClient,
    parseJob,
    getJob,
    createJob,
    createDeadLetter,
    getDeadLetters,
    logger,
  }: {
    prismaClient: PrismaClient;
    parseJob: (input: Input) => E.Either<Error, Jobs>;
    getJob: (client: PrismaClient) => Promise<O.Option<Input>>;
    createJob: (client: TransactionClient, data: string) => Promise<void>;
    createDeadLetter: (
      client: PrismaClient,
      input: DeadLetters
    ) => Promise<void>;
    getDeadLetters: (client: PrismaClient) => Promise<DeadLetters[]>;
    logger?: Console;
  }) {
    this.client = prismaClient;
    this.parseJob = parseJob;
    this.getJob = getJob.bind(this, this.client);
    this.createJob = createJob;
    this.createDeadLetter = createDeadLetter.bind(this, this.client);
    this.getDeadLetters = getDeadLetters.bind(this, this.client);
    this.log = logger;

    // I'm binding this, because run eventually gets run in a setTimeout
    // but needs refrence to `this`
    this.run = this.run.bind(this);
  }

  /**
   * Queues a new job for processing. It relies on Prisma's transaction client which must be passed by the caller.
   * Using this client means that if any calls fail, then they will all fail - including the call to create the job.
   *
   * @param {(tx: TransactionClient) => Promise<{ data: Input; job: Jobs }>} fn - A function that takes the transaction client, returns the input data and job to be processed.

  */
  queue<Input>(
    fn: (tx: TransactionClient) => Promise<{ data: Input; job: Jobs }>
  ): Promise<Input> {
    return this.client.$transaction(async (tx: TransactionClient) => {
      const { data, job } = await fn(tx);

      // save the stringified job.
      await this.createJob(tx, JSON.stringify(job));

      // Return the data, which can be used by the caller
      return data;
    });
  }

  /**
   * Runs the next available job by finding it using getJob and parsing it with the provided parser.
   * If a job is found, it is executed using the provided handleJobs function. If the job succeeds, it is deleted.
   * If it fails, it is deleted from the job queue and added to the dead letter queue.
   * @param {Function} handleJobs - A function that takes a job object and returns a Promise that resolves when the job is completed.
   * @returns {Promise<void>} - A Promise that resolves with nothing when the function completes.
   */
  async run(handleJobs: (job: Jobs) => Promise<void>): Promise<void> {
    this.log.info(`Attempting to find job`);
    pipe(
      await this.getJob(),
      O.match(
        () => this.log.info("No job found"),
        (job: Input) => {
          this.log.info(`Running job with id ${job.id}`);
          return pipe(
            TE.fromEither(this.parseJob(job)),
            flow(
              TE.chain((parsed) =>
                TE.tryCatch(
                  () => handleJobs(parsed),
                  (err) => new Error(`handling job failed: ${err}`)
                )
              ),
              TE.fold(
                // An error has been returned somewhere in the chain, so we delete the job
                // and add it to the DLQ
                (err) => async () => {
                  this.log.error(`An error occured: ${err}`);
                  await this.client.job.delete({ where: { id: job.id } });
                  await this.client.deadLetters.create({
                    data: {
                      id: job.id,
                      data: job.data,
                    },
                  });
                },

                // The job has succeeded
                () => async () => {
                  this.log.info(`Finished processing job with id ${job.id}`);
                  await this.client.job.delete({ where: { id: job.id } });
                }
              )
            )
          )();
        }
      )
    );
  }
}
